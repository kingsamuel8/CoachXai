/**
 * 녹음 처리 러너 — 세그먼트가 모두 도착한(queued) 녹음을
 *   결합 → 받아쓰기 → 요약 → 저장 → 코치 푸시
 * 로 처리한다. (docs/VOICE_RECORDING_PLAN.md §4.2, §11.5)
 *
 * - 행은 FOR UPDATE SKIP LOCKED 로 잡아 서버가 여러 대여도 한 번만 처리한다.
 * - 실패하면 2·4·8분 뒤 최대 3번 다시 시도하고, 그래도 안 되면 failed.
 *   원본 오디오는 남아 있으므로 POST /:id/retry 로 다시 돌릴 수 있다.
 * - 처리 중 서버가 죽어 'processing' 으로 남은 행은 30분 뒤 다시 대기열로.
 * - 외부 의존(R2·받아쓰기·요약·푸시)은 주입받아 테스트에서 바꿔 끼운다.
 */
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import pool from '../db';
import { downloadToFile } from '../r2';
import { sendToUser, type PushPayload } from '../fcm';
import { joinSegments, probeDurationSec } from './audio';
import { elevenLabsEngine, GOLF_KEYTERMS, type SttEngine } from './stt';
import {
  buildSummaryPrompt,
  cleanSummary,
  geminiSummarizer,
  SUMMARY_PROMPT_VERSION,
  type Summarizer,
} from './summary';

export const MAX_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 30_000;
const STUCK_PROCESSING_MS = 30 * 60 * 1000;

export interface ProcessorDeps {
  stt: SttEngine;
  summarizer: Summarizer;
  download: (key: string, file: string) => Promise<unknown>;
  push: (coachId: string, payload: PushPayload) => Promise<unknown>;
  now: () => number;
}

export const defaultDeps = (): ProcessorDeps => ({
  stt: elevenLabsEngine(),
  summarizer: geminiSummarizer(),
  download: downloadToFile,
  push: (coachId, payload) => sendToUser(coachId, 'coach', payload),
  now: Date.now,
});

/** 다음 재시도 시각 — 실패 횟수에 따라 2, 4, 8분. */
export const retryDelayMs = (attempts: number): number => 2 ** Math.max(1, attempts) * 60_000;

interface ClaimedRow {
  id: string;
  coach_id: string;
  client_id: string | null;
  client_name: string | null;
  attempts: number;
}

/** 처리할 녹음 하나를 잡아 'processing' 으로 바꾼다. 없으면 null. */
export async function claimNext(now: number): Promise<ClaimedRow | null> {
  const r = await pool.query<ClaimedRow>(
    `UPDATE lesson_recordings lr
        SET status = 'processing', attempts = lr.attempts + 1, updated_at = $1
      WHERE lr.id = (
        SELECT id FROM lesson_recordings
         WHERE audio_deleted_at IS NULL
           AND attempts < $3
           AND (
                 (status = 'queued' AND COALESCE(next_attempt_at, 0) <= $1)
              OR (status = 'processing' AND updated_at <= $2)
           )
         ORDER BY COALESCE(next_attempt_at, updated_at)
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING lr.id, lr.coach_id, lr.client_id, lr.client_name, lr.attempts`,
    [now, now - STUCK_PROCESSING_MS, MAX_ATTEMPTS]
  );
  return r.rows[0] ?? null;
}

/**
 * 처리 도중 서버가 죽기를 반복해 시도 횟수를 다 쓴 채 'processing' 에 멈춘 녹음을
 * failed 로 돌린다(그대로 두면 아무도 다시 잡지 않고 코치는 영원히 "정리 중"을 본다).
 */
export async function failExhaustedStuck(now: number): Promise<number> {
  const r = await pool.query(
    `UPDATE lesson_recordings
        SET status = 'failed', error = COALESCE(error, '처리 중 서버가 여러 번 중단됐어요'), updated_at = $1
      WHERE status = 'processing' AND updated_at <= $2 AND attempts >= $3`,
    [now, now - STUCK_PROCESSING_MS, MAX_ATTEMPTS]
  );
  return r.rowCount ?? 0;
}

/** 같은 학생의 지난 녹음 요약(있으면). 비교 문단에 쓴다. */
async function previousSummary(row: ClaimedRow): Promise<string | null> {
  if (!row.client_id && !row.client_name) return null;
  const r = await pool.query<{ summary_md: string }>(
    `SELECT summary_md FROM lesson_recordings
      WHERE coach_id = $1 AND id <> $2 AND status = 'ready' AND summary_md IS NOT NULL
        AND (($3::text IS NOT NULL AND client_id = $3) OR ($3::text IS NULL AND client_name = $4))
      ORDER BY started_at DESC LIMIT 1`,
    [row.coach_id, row.id, row.client_id, row.client_name]
  );
  return r.rows[0]?.summary_md ?? null;
}

export async function processRecording(row: ClaimedRow, deps: ProcessorDeps): Promise<void> {
  const segs = await pool.query<{ seq: number; r2_key: string }>(
    'SELECT seq, r2_key FROM recording_segments WHERE recording_id = $1 ORDER BY seq',
    [row.id]
  );
  if (segs.rowCount === 0) throw new Error('세그먼트가 없어요');

  const dir = await mkdtemp(path.join(os.tmpdir(), `rec-${row.id}-`));
  try {
    // 1. 결합
    const files: string[] = [];
    for (const s of segs.rows) {
      const f = path.join(dir, `seg-${String(s.seq).padStart(4, '0')}.m4a`);
      await deps.download(s.r2_key, f);
      files.push(f);
    }
    const full = path.join(dir, 'full.m4a');
    await joinSegments(files, full);
    const durationSec = await probeDurationSec(full);

    // 2. 받아쓰기
    const stt = await deps.stt.transcribe(full, { keyterms: GOLF_KEYTERMS });

    // 3. 요약 — 말소리가 없으면 요약하지 않는다(지어내지 않도록).
    let summaryMd: string | null = null;
    let summaryModel: string | null = null;
    if (stt.segments.length > 0) {
      const prompt = buildSummaryPrompt(stt.segments, {
        studentName: row.client_name,
        previousSummary: await previousSummary(row),
      });
      const out = await deps.summarizer.summarize(prompt);
      summaryMd = cleanSummary(out.text);
      summaryModel = `${deps.summarizer.name}:${out.model}:${SUMMARY_PROMPT_VERSION}`;
    }

    // 4. 저장 — 받아쓰기 원문(raw_text)은 이후 코치 수정과 별개로 보존.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM transcript_segments WHERE recording_id = $1', [row.id]);
      for (let i = 0; i < stt.segments.length; i++) {
        const s = stt.segments[i];
        await client.query(
          `INSERT INTO transcript_segments (recording_id, idx, start_ms, end_ms, speaker, raw_text, text)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [row.id, i, s.startMs, s.endMs, s.speaker ?? 'unknown', s.text]
        );
      }
      const now = deps.now();
      await client.query(
        `UPDATE lesson_recordings
            SET status = 'ready', error = NULL, next_attempt_at = NULL,
                summary_md = $2, summary_model = $3, transcript_engine = $4, stt_engine = $4,
                processed_at = $5, updated_at = $5,
                duration_ms = COALESCE(NULLIF($6::bigint, 0), duration_ms)
          WHERE id = $1`,
        [row.id, summaryMd, summaryModel, stt.engine, now, Math.round(durationSec * 1000)]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // 5. 알림 — 실패해도 처리 결과는 그대로 둔다.
  const who = row.client_name ? `${row.client_name} 회원` : '레슨';
  await deps
    .push(row.coach_id, {
      title: '레슨 정리가 끝났어요',
      body: `${who} 녹음의 받아쓰기와 요약을 확인해 보세요`,
      data: { type: 'LESSON_RECORDING_READY', recordingId: row.id, deepLink: `/recordings/${row.id}` },
    })
    .catch((err) => console.warn('[recordingProcessor] push failed', { id: row.id, err }));
}

async function markFailure(row: ClaimedRow, err: unknown, now: number): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const giveUp = row.attempts >= MAX_ATTEMPTS;
  await pool.query(
    `UPDATE lesson_recordings
        SET status = $2, error = $3, next_attempt_at = $4, updated_at = $5
      WHERE id = $1`,
    [row.id, giveUp ? 'failed' : 'queued', message.slice(0, 1000), giveUp ? null : now + retryDelayMs(row.attempts), now]
  );
}

/** 대기 중인 녹음을 하나씩 모두 처리한다. 처리한 개수를 돌려준다. */
export async function processPending(deps: ProcessorDeps = defaultDeps(), limit = 10): Promise<number> {
  await failExhaustedStuck(deps.now());
  let n = 0;
  for (; n < limit; n++) {
    const row = await claimNext(deps.now());
    if (!row) break;
    try {
      await processRecording(row, deps);
    } catch (err) {
      console.error('[recordingProcessor] failed', { id: row.id, attempt: row.attempts, err });
      await markFailure(row, err, deps.now());
    }
  }
  return n;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startRecordingProcessor(): void {
  if (timer) return;
  if (!process.env.ELEVENLABS_API_KEY) {
    console.warn('[recordingProcessor] ELEVENLABS_API_KEY not set — recordings will wait in the queue.');
    return;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processPending();
    } catch (err) {
      console.error('[recordingProcessor] tick failed', err);
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  void tick();
}

export function stopRecordingProcessor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
