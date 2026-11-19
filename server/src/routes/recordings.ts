/**
 * 레슨 녹음 v2 API (docs/VOICE_RECORDING_PLAN.md §4.2).
 *
 * 앱의 네이티브 녹음기가 60초 세그먼트를 레슨 중에 계속 올린다. 화면이
 * 꺼진 채 OS 가 대신 업로드하므로, 세그먼트·공백·종료 경로는 로그인 토큰이
 * 아니라 녹음 시작 때 발급한 **녹음 전용 업로드 토큰**으로도 받는다.
 *
 *   POST   /api/recordings                    녹음 시작 (코치)
 *   GET    /api/recordings/storage            보관 사용량/한도 (코치)
 *   PUT    /api/recordings/:id/segments/:seq  세그먼트 업로드 (업로드 토큰|코치)
 *   POST   /api/recordings/:id/gaps           녹음 공백 기록 (업로드 토큰|코치)
 *   POST   /api/recordings/:id/complete       종료 선언 (업로드 토큰|코치)
 *   GET    /api/recordings/:id                상태 조회 (코치)
 *   POST   /api/recordings/:id/keep           원본 보관 (코치)
 *   DELETE /api/recordings/:id/keep           보관 해제 (코치)
 */
import express, { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../services/db';
import { putObject } from '../services/r2';
import type { AuthPayload } from '../middleware/auth';
import {
  AUDIO_RETENTION_MS,
  HOUR_MS,
  KEEP_QUOTA_MS,
  MAX_SEGMENT_BYTES,
  NEXT_PLAN,
  RecordingStatus,
  UPLOAD_TOKEN_TTL_SEC,
  acceptsSegments,
  audioExpiresAt,
  canKeep,
  effectivePlan,
  isValidSeq,
  missingSegments,
  segmentKey,
  signUploadToken,
  statusAfterComplete,
  verifyUploadToken,
} from '../services/recordingPolicy';

const router = Router();

/** 보관을 해제했을 때 원본이 지워지기까지 최소 유예. */
const UNKEEP_GRACE_MS = 24 * HOUR_MS;

// ─── 인증 ────────────────────────────────────────────────────────────────────

interface RecordingAuth {
  coachId: string;
  /** 업로드 토큰으로 들어왔다면 그 토큰이 허용하는 녹음 id. */
  scopedRecordingId?: string;
}

declare global {
  namespace Express {
    interface Request {
      recordingAuth?: RecordingAuth;
    }
  }
}

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice(7) : null;
}

/**
 * 코치 로그인 토큰만 받는다.
 * (세그먼트 경로와 같은 라우터라 공용 authMiddleware 대신 직접 검사한다.)
 */
function coachOnly(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.JWT_SECRET;
  const token = bearer(req);
  if (!secret) {
    res.status(500).json({ error: 'JWT_SECRET is not configured' });
    return;
  }
  if (!token) {
    res.status(401).json({ error: 'Missing authorization token' });
    return;
  }
  try {
    const p = jwt.verify(token, secret) as AuthPayload;
    if (p.role !== 'coach' || !p.id) {
      res.status(403).json({ error: '코치만 녹음할 수 있어요' });
      return;
    }
    req.recordingAuth = { coachId: p.id };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** 업로드 토큰(해당 녹음 한정) 또는 코치 로그인 토큰. */
function uploaderOrCoach(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.JWT_SECRET;
  const token = bearer(req);
  if (secret && token) {
    const scoped = verifyUploadToken(token, secret);
    if (scoped) {
      if (scoped.recordingId !== req.params.id) {
        res.status(403).json({ error: '다른 녹음의 업로드 토큰이에요' });
        return;
      }
      req.recordingAuth = { coachId: scoped.coachId, scopedRecordingId: scoped.recordingId };
      next();
      return;
    }
  }
  coachOnly(req, res, next);
}

interface RecordingRow {
  id: string;
  coach_id: string;
  client_id: string | null;
  client_name: string | null;
  lesson_id: string | null;
  status: RecordingStatus;
  mime_type: string;
  segment_count: number | null;
  duration_ms: string | null;
  bytes: string;
  started_at: string;
  ended_at: string | null;
  audio_expires_at: string | null;
  kept_at: string | null;
  audio_deleted_at: string | null;
  stt_engine: string | null;
  error: string | null;
}

const num = (v: string | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

async function loadOwned(id: string, coachId: string): Promise<RecordingRow | null> {
  const r = await pool.query<RecordingRow>(
    'SELECT * FROM lesson_recordings WHERE id = $1 AND coach_id = $2',
    [id, coachId]
  );
  return r.rows[0] ?? null;
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

router.param('id', (req, res, next, id: string) => {
  if (!isUuid(id)) {
    res.status(404).json({ error: '녹음을 찾을 수 없어요' });
    return;
  }
  next();
});

/** 보관 중인(삭제되지 않은) 원본 길이 합. */
async function keptUsageMs(coachId: string, excludeId?: string): Promise<number> {
  const r = await pool.query<{ used: string | null }>(
    `SELECT COALESCE(SUM(duration_ms), 0) AS used
       FROM lesson_recordings
      WHERE coach_id = $1 AND kept_at IS NOT NULL AND audio_deleted_at IS NULL
        AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [coachId, excludeId ?? null]
  );
  return Number(r.rows[0]?.used ?? 0);
}

async function coachPlan(coachId: string) {
  const r = await pool.query(
    'SELECT is_subscribed, subscription_plan, subscription_end_date FROM coaches WHERE id = $1',
    [coachId]
  );
  return effectivePlan(r.rows[0] ?? {});
}

function present(row: RecordingRow, uploadedSeqs?: number[]) {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    lessonId: row.lesson_id,
    status: row.status,
    segmentCount: row.segment_count,
    uploadedSegments: uploadedSeqs?.length,
    missingSegments:
      uploadedSeqs && row.segment_count !== null
        ? missingSegments(row.segment_count, uploadedSeqs)
        : undefined,
    durationMs: num(row.duration_ms),
    bytes: Number(row.bytes),
    startedAt: Number(row.started_at),
    endedAt: num(row.ended_at),
    audioExpiresAt: num(row.audio_expires_at),
    kept: row.kept_at !== null,
    audioDeleted: row.audio_deleted_at !== null,
    error: row.error,
  };
}

// ─── 녹음 시작 ──────────────────────────────────────────────────────────────

router.post('/', express.json(), coachOnly, async (req: Request, res: Response) => {
  try {
    const { coachId } = req.recordingAuth!;
    const { clientId, clientName, lessonId, startedAt, mimeType } = req.body ?? {};
    const now = Date.now();
    const started = Number.isFinite(Number(startedAt)) ? Number(startedAt) : now;
    const r = await pool.query<RecordingRow>(
      `INSERT INTO lesson_recordings
         (coach_id, client_id, client_name, lesson_id, status, mime_type, started_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'recording', $5, $6, $7, $7)
       RETURNING *`,
      [
        coachId,
        typeof clientId === 'string' ? clientId : null,
        typeof clientName === 'string' ? clientName.slice(0, 255) : null,
        typeof lessonId === 'string' ? lessonId : null,
        typeof mimeType === 'string' && mimeType.startsWith('audio/') ? mimeType : 'audio/mp4',
        started,
        now,
      ]
    );
    const row = r.rows[0];
    res.status(201).json({
      recording: present(row, []),
      uploadToken: signUploadToken(row.id, coachId, process.env.JWT_SECRET!),
      uploadTokenExpiresAt: now + UPLOAD_TOKEN_TTL_SEC * 1000,
    });
  } catch (err) {
    console.error('[recordings] create failed', err);
    res.status(500).json({ error: '녹음을 시작하지 못했어요' });
  }
});

// ─── 보관 사용량 ────────────────────────────────────────────────────────────

router.get('/storage', coachOnly, async (req: Request, res: Response) => {
  try {
    const { coachId } = req.recordingAuth!;
    const [plan, usedMs] = await Promise.all([coachPlan(coachId), keptUsageMs(coachId)]);
    res.json({ plan, usedMs, limitMs: KEEP_QUOTA_MS[plan], nextPlan: NEXT_PLAN[plan] });
  } catch (err) {
    console.error('[recordings] storage failed', err);
    res.status(500).json({ error: '보관 용량을 불러오지 못했어요' });
  }
});

// ─── 세그먼트 업로드 ────────────────────────────────────────────────────────

router.put(
  '/:id/segments/:seq',
  uploaderOrCoach,
  express.raw({ type: () => true, limit: MAX_SEGMENT_BYTES }),
  async (req: Request, res: Response) => {
    const { coachId } = req.recordingAuth!;
    const id = req.params.id;
    const seq = Number(req.params.seq);
    if (!isValidSeq(seq)) {
      res.status(400).json({ error: '잘못된 세그먼트 순번이에요' });
      return;
    }
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: '빈 세그먼트예요' });
      return;
    }
    const durationHeader = Number(req.headers['x-segment-duration-ms']);
    const durationMs = Number.isFinite(durationHeader) && durationHeader > 0 ? Math.round(durationHeader) : null;

    try {
      const row = await loadOwned(id, coachId);
      if (!row) {
        res.status(404).json({ error: '녹음을 찾을 수 없어요' });
        return;
      }
      if (!acceptsSegments(row.status)) {
        // 재전송은 정상이다(OS 업로더는 응답을 놓치면 다시 보낸다). 이미 받은
        // 순번이면 성공으로 답해 업로더가 재시도를 멈추게 한다.
        const exists = await pool.query(
          'SELECT 1 FROM recording_segments WHERE recording_id = $1 AND seq = $2',
          [id, seq]
        );
        if (exists.rowCount) res.json({ ok: true, duplicate: true, status: row.status });
        else res.status(409).json({ error: '이미 정리가 시작된 녹음이에요', status: row.status });
        return;
      }

      const key = segmentKey(coachId, id, seq);
      await putObject(key, body, row.mime_type);

      // 동시에 여러 세그먼트가 도착해도 상태 전환이 한 번만 일어나게 행을 잠근다.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query<RecordingRow>(
          'SELECT * FROM lesson_recordings WHERE id = $1 FOR UPDATE',
          [id]
        );
        const current = locked.rows[0];
        const now = Date.now();
        await client.query(
          `INSERT INTO recording_segments (recording_id, seq, r2_key, bytes, duration_ms, uploaded_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (recording_id, seq)
             DO UPDATE SET r2_key = EXCLUDED.r2_key, bytes = EXCLUDED.bytes,
                           duration_ms = EXCLUDED.duration_ms, uploaded_at = EXCLUDED.uploaded_at`,
          [id, seq, key, body.length, durationMs, now]
        );
        const seqs = await client.query<{ seq: number }>(
          'SELECT seq FROM recording_segments WHERE recording_id = $1',
          [id]
        );
        const uploaded = seqs.rows.map((s) => s.seq);
        let status = current.status;
        if (status === 'uploading' && current.segment_count !== null) {
          status = statusAfterComplete(current.segment_count, uploaded);
        }
        await client.query(
          `UPDATE lesson_recordings
              SET bytes = (SELECT COALESCE(SUM(bytes), 0) FROM recording_segments WHERE recording_id = $1),
                  status = $2, updated_at = $3
            WHERE id = $1`,
          [id, status, now]
        );
        await client.query('COMMIT');
        res.json({ ok: true, seq, status });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[recordings] segment upload failed', { id, seq, err });
      res.status(500).json({ error: '세그먼트를 저장하지 못했어요' });
    }
  }
);

// ─── 녹음 공백 (전화 수신 등) ────────────────────────────────────────────────

router.post('/:id/gaps', uploaderOrCoach, express.json(), async (req: Request, res: Response) => {
  try {
    const { coachId } = req.recordingAuth!;
    const row = await loadOwned(req.params.id, coachId);
    if (!row) {
      res.status(404).json({ error: '녹음을 찾을 수 없어요' });
      return;
    }
    const startMs = Number(req.body?.startMs);
    const endMs = req.body?.endMs === undefined || req.body?.endMs === null ? null : Number(req.body.endMs);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 50) : 'interrupted';
    if (!Number.isFinite(startMs) || startMs < 0 || (endMs !== null && !(endMs >= startMs))) {
      res.status(400).json({ error: '잘못된 공백 구간이에요' });
      return;
    }
    await pool.query(
      `INSERT INTO recording_gaps (recording_id, start_ms, end_ms, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (recording_id, start_ms) DO UPDATE SET end_ms = EXCLUDED.end_ms, reason = EXCLUDED.reason`,
      [row.id, Math.round(startMs), endMs === null ? null : Math.round(endMs), reason]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[recordings] gap failed', err);
    res.status(500).json({ error: '공백 구간을 저장하지 못했어요' });
  }
});

// ─── 종료 선언 ──────────────────────────────────────────────────────────────

router.post('/:id/complete', uploaderOrCoach, express.json(), async (req: Request, res: Response) => {
  const { coachId } = req.recordingAuth!;
  const id = req.params.id;
  const segmentCount = Number(req.body?.segmentCount);
  const durationMs = Number(req.body?.durationMs);
  if (!Number.isInteger(segmentCount) || segmentCount < 1 || !isValidSeq(segmentCount - 1)) {
    res.status(400).json({ error: '잘못된 세그먼트 수예요' });
    return;
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    res.status(400).json({ error: '잘못된 녹음 길이예요' });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query<RecordingRow>(
      'SELECT * FROM lesson_recordings WHERE id = $1 AND coach_id = $2 FOR UPDATE',
      [id, coachId]
    );
    const row = locked.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: '녹음을 찾을 수 없어요' });
      return;
    }
    const seqs = await client.query<{ seq: number }>(
      'SELECT seq FROM recording_segments WHERE recording_id = $1',
      [id]
    );
    const uploaded = seqs.rows.map((s) => s.seq);

    // 같은 종료 선언의 재전송 — 상태를 되돌리지 않고 현재 상태를 돌려준다.
    if (row.status !== 'recording' && row.status !== 'uploading') {
      await client.query('COMMIT');
      res.json({ recording: present(row, uploaded) });
      return;
    }

    const now = Date.now();
    const endedAt = Number(row.started_at) + Math.round(durationMs);
    const status = statusAfterComplete(segmentCount, uploaded);
    const updated = await client.query<RecordingRow>(
      `UPDATE lesson_recordings
          SET status = $2, segment_count = $3, duration_ms = $4, ended_at = $5,
              audio_expires_at = CASE WHEN kept_at IS NULL THEN $6::bigint ELSE NULL END,
              updated_at = $7
        WHERE id = $1
        RETURNING *`,
      [id, status, segmentCount, Math.round(durationMs), endedAt, audioExpiresAt(endedAt), now]
    );
    await client.query('COMMIT');
    res.json({ recording: present(updated.rows[0], uploaded) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('[recordings] complete failed', { id, err });
    res.status(500).json({ error: '녹음을 마무리하지 못했어요' });
  } finally {
    client.release();
  }
});

// ─── 조회 ───────────────────────────────────────────────────────────────────

router.get('/:id', coachOnly, async (req: Request, res: Response) => {
  try {
    const row = await loadOwned(req.params.id, req.recordingAuth!.coachId);
    if (!row) {
      res.status(404).json({ error: '녹음을 찾을 수 없어요' });
      return;
    }
    const [seqs, gaps] = await Promise.all([
      pool.query<{ seq: number }>('SELECT seq FROM recording_segments WHERE recording_id = $1', [row.id]),
      pool.query(
        'SELECT start_ms, end_ms, reason FROM recording_gaps WHERE recording_id = $1 ORDER BY start_ms',
        [row.id]
      ),
    ]);
    res.json({
      recording: present(
        row,
        seqs.rows.map((s) => s.seq)
      ),
      gaps: gaps.rows.map((g) => ({ startMs: Number(g.start_ms), endMs: num(g.end_ms), reason: g.reason })),
    });
  } catch (err) {
    console.error('[recordings] get failed', err);
    res.status(500).json({ error: '녹음을 불러오지 못했어요' });
  }
});

// ─── 원본 보관 ──────────────────────────────────────────────────────────────

router.post('/:id/keep', coachOnly, async (req: Request, res: Response) => {
  const { coachId } = req.recordingAuth!;
  try {
    const row = await loadOwned(req.params.id, coachId);
    if (!row) {
      res.status(404).json({ error: '녹음을 찾을 수 없어요' });
      return;
    }
    if (row.audio_deleted_at) {
      res.status(410).json({ error: '원본이 이미 삭제됐어요' });
      return;
    }
    if (row.duration_ms === null) {
      res.status(409).json({ error: '녹음이 끝난 뒤에 보관할 수 있어요' });
      return;
    }
    if (row.kept_at) {
      res.json({ recording: present(row) });
      return;
    }
    const [plan, usedMs] = await Promise.all([coachPlan(coachId), keptUsageMs(coachId, row.id)]);
    const decision = canKeep(plan, usedMs, Number(row.duration_ms));
    if (!decision.ok) {
      // 402: 결제(상위 플랜)로 풀 수 있는 거절.
      res.status(402).json({
        error: '보관 공간이 가득 찼어요',
        plan,
        usedMs: decision.usedMs,
        limitMs: decision.limitMs,
        nextPlan: decision.nextPlan,
      });
      return;
    }
    const updated = await pool.query<RecordingRow>(
      `UPDATE lesson_recordings
          SET kept_at = $2, audio_expires_at = NULL, updated_at = $2
        WHERE id = $1 AND audio_deleted_at IS NULL
        RETURNING *`,
      [row.id, Date.now()]
    );
    if (!updated.rows[0]) {
      res.status(410).json({ error: '원본이 이미 삭제됐어요' });
      return;
    }
    res.json({ recording: present(updated.rows[0]) });
  } catch (err) {
    console.error('[recordings] keep failed', err);
    res.status(500).json({ error: '보관하지 못했어요' });
  }
});

router.delete('/:id/keep', coachOnly, async (req: Request, res: Response) => {
  const { coachId } = req.recordingAuth!;
  try {
    const row = await loadOwned(req.params.id, coachId);
    if (!row) {
      res.status(404).json({ error: '녹음을 찾을 수 없어요' });
      return;
    }
    if (!row.kept_at || row.audio_deleted_at) {
      res.json({ recording: present(row) });
      return;
    }
    const now = Date.now();
    // 오래된 녹음의 보관을 풀자마자 지워지지 않게 최소 하루는 남긴다.
    const ended = num(row.ended_at) ?? now;
    const expires = Math.max(ended + AUDIO_RETENTION_MS, now + UNKEEP_GRACE_MS);
    const updated = await pool.query<RecordingRow>(
      `UPDATE lesson_recordings SET kept_at = NULL, audio_expires_at = $2, updated_at = $3
        WHERE id = $1 RETURNING *`,
      [row.id, expires, now]
    );
    res.json({ recording: present(updated.rows[0]) });
  } catch (err) {
    console.error('[recordings] unkeep failed', err);
    res.status(500).json({ error: '보관을 해제하지 못했어요' });
  }
});

export default router;
