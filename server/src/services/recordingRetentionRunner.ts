/**
 * 레슨 녹음 원본 정리 러너 (docs/VOICE_RECORDING_PLAN.md §7).
 *
 * 한 시간마다 아래 원본 오디오를 R2 에서 지운다. 받아쓰기·요약은 남는다.
 *  - 보관하지 않았고 audio_expires_at(종료 + 3일)이 지난 녹음
 *  - 종료 선언 없이 3일 넘게 방치된 녹음(앱이 죽고 다시 열리지 않은 경우)
 *
 * scheduledPushRunner 와 같이 FOR UPDATE SKIP LOCKED 로 행을 잡아, 서버가
 * 여러 대여도 같은 녹음을 두 번 지우지 않는다.
 */
import pool from './db';
import { deletePrefix } from './r2';
import { AUDIO_RETENTION_MS } from './recordingPolicy';

const POLL_INTERVAL_MS = 60 * 60 * 1000;
const BATCH = 50;
let timer: NodeJS.Timeout | null = null;
let running = false;

export const recordingPrefix = (coachId: string, recordingId: string) =>
  `recordings/${coachId}/${recordingId}/`;

export async function sweepExpiredRecordings(now: number = Date.now()): Promise<number> {
  const due = await pool.query<{ id: string; coach_id: string }>(
    `SELECT id, coach_id
       FROM lesson_recordings
      WHERE kept_at IS NULL AND audio_deleted_at IS NULL
        AND (
              audio_expires_at <= $1
           OR (ended_at IS NULL AND updated_at <= $2)
        )
      ORDER BY COALESCE(audio_expires_at, updated_at)
      LIMIT $3`,
    [now, now - AUDIO_RETENTION_MS, BATCH]
  );
  let swept = 0;
  for (const row of due.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // 그사이 코치가 보관을 눌렀거나 다른 인스턴스가 지웠으면 건너뛴다.
      const still = await client.query(
        `SELECT 1 FROM lesson_recordings
          WHERE id = $1 AND kept_at IS NULL AND audio_deleted_at IS NULL
          FOR UPDATE SKIP LOCKED`,
        [row.id]
      );
      if (!still.rowCount) {
        await client.query('ROLLBACK');
        continue;
      }
      await deletePrefix(recordingPrefix(row.coach_id, row.id));
      await client.query('DELETE FROM recording_segments WHERE recording_id = $1', [row.id]);
      await client.query(
        `UPDATE lesson_recordings
            SET audio_deleted_at = $2, updated_at = $2,
                status = CASE WHEN status IN ('recording', 'uploading') THEN 'failed' ELSE status END,
                error = CASE WHEN status IN ('recording', 'uploading')
                             THEN '종료되지 않은 채 3일이 지나 원본이 삭제됐어요' ELSE error END
          WHERE id = $1`,
        [row.id, now]
      );
      await client.query('COMMIT');
      swept += 1;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error('[recordingRetention] sweep failed', { id: row.id, err });
    } finally {
      client.release();
    }
  }
  return swept;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const n = await sweepExpiredRecordings();
    if (n > 0) console.log(`[recordingRetention] deleted raw audio for ${n} recording(s)`);
  } catch (err) {
    console.error('[recordingRetention] tick failed', err);
  } finally {
    running = false;
  }
}

export function startRecordingRetentionRunner(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  void tick();
}

export function stopRecordingRetentionRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
