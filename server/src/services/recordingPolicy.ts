/**
 * 레슨 녹음 v2 정책 — DB·네트워크 없이 판정만 하는 순수 함수 모음.
 * (docs/VOICE_RECORDING_PLAN.md §4, §7)
 */
import jwt from 'jsonwebtoken';

// ─── 보관 ────────────────────────────────────────────────────────────────────

/** 원본 오디오 기본 보관 기간 — 종료 후 3일. */
export const AUDIO_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export const HOUR_MS = 60 * 60 * 1000;

export type CoachPlan = 'FREE' | 'PRO' | 'PRO_PLUS' | 'PRO_MAX';

/**
 * 플랜별 원본 보관 한도(ms). 보관을 누른 녹음의 길이 합이 이 안에 있어야 한다.
 * 3일 자동 삭제되는 원본은 한도에 잡히지 않는다.
 */
export const KEEP_QUOTA_MS: Record<CoachPlan, number> = {
  FREE: 0,
  PRO: 20 * HOUR_MS,
  PRO_PLUS: 100 * HOUR_MS,
  PRO_MAX: 500 * HOUR_MS,
};

/** 한도를 늘리려면 올라갈 다음 플랜. 최상위면 null. */
export const NEXT_PLAN: Record<CoachPlan, CoachPlan | null> = {
  FREE: 'PRO',
  PRO: 'PRO_PLUS',
  PRO_PLUS: 'PRO_MAX',
  PRO_MAX: null,
};

const PLANS: readonly CoachPlan[] = ['FREE', 'PRO', 'PRO_PLUS', 'PRO_MAX'];

/**
 * coaches 행에서 지금 실제로 유효한 플랜을 고른다.
 * 구독이 꺼졌거나 만료일이 지났으면 FREE.
 */
export function effectivePlan(
  row: {
    is_subscribed?: boolean | null;
    subscription_plan?: string | null;
    subscription_end_date?: string | null;
  },
  now: number = Date.now()
): CoachPlan {
  if (!row.is_subscribed) return 'FREE';
  const plan = (row.subscription_plan ?? '').toUpperCase() as CoachPlan;
  if (!PLANS.includes(plan)) return 'FREE';
  if (row.subscription_end_date) {
    const end = Date.parse(row.subscription_end_date);
    if (Number.isFinite(end) && end < now) return 'FREE';
  }
  return plan;
}

export type KeepDecision =
  | { ok: true }
  | {
      ok: false;
      reason: 'quota_exceeded';
      usedMs: number;
      limitMs: number;
      nextPlan: CoachPlan | null;
    };

/** 이 녹음(durationMs)을 보관해도 한도 안인가. */
export function canKeep(plan: CoachPlan, usedMs: number, durationMs: number): KeepDecision {
  const limitMs = KEEP_QUOTA_MS[plan];
  if (usedMs + Math.max(0, durationMs) <= limitMs) return { ok: true };
  return { ok: false, reason: 'quota_exceeded', usedMs, limitMs, nextPlan: NEXT_PLAN[plan] };
}

/** 종료 시각 기준 원본 만료 시각. */
export const audioExpiresAt = (endedAt: number): number => endedAt + AUDIO_RETENTION_MS;

// ─── 세그먼트 ────────────────────────────────────────────────────────────────

/** 세그먼트 하나의 최대 크기. 60초 32kbps AAC ≈ 240KB 라 넉넉하다. */
export const MAX_SEGMENT_BYTES = 5 * 1024 * 1024;
/** 한 녹음의 최대 세그먼트 수 — 60초 단위로 10시간. */
export const MAX_SEGMENTS = 600;

export function isValidSeq(seq: number): boolean {
  return Number.isInteger(seq) && seq >= 0 && seq < MAX_SEGMENTS;
}

/** 0..segmentCount-1 중 아직 안 올라온 순번. */
export function missingSegments(segmentCount: number, uploaded: Iterable<number>): number[] {
  const have = new Set(uploaded);
  const missing: number[] = [];
  for (let i = 0; i < segmentCount; i++) if (!have.has(i)) missing.push(i);
  return missing;
}

export const segmentKey = (coachId: string, recordingId: string, seq: number): string =>
  `recordings/${coachId}/${recordingId}/seg-${String(seq).padStart(4, '0')}.m4a`;

export type RecordingStatus =
  | 'recording'
  | 'uploading'
  | 'queued'
  | 'processing'
  | 'ready'
  | 'failed';

/** 세그먼트를 받을 수 있는 상태인가 — 처리에 들어간 뒤에는 원본을 바꾸지 않는다. */
export const acceptsSegments = (status: RecordingStatus): boolean =>
  status === 'recording' || status === 'uploading';

/**
 * 종료 선언 뒤의 상태. 세그먼트가 다 모였으면 처리 대기열로, 아니면
 * 나머지가 올라올 때까지 uploading 에 머문다.
 */
export function statusAfterComplete(segmentCount: number, uploaded: Iterable<number>): RecordingStatus {
  return missingSegments(segmentCount, uploaded).length === 0 ? 'queued' : 'uploading';
}

// ─── 업로드 토큰 ─────────────────────────────────────────────────────────────

/**
 * 녹음 전용 업로드 토큰 유효 시간. 로그인 토큰이 레슨 중에 만료돼도
 * 네이티브 업로더가 끊기지 않게 녹음 시작 시 따로 발급한다.
 */
export const UPLOAD_TOKEN_TTL_SEC = 12 * 60 * 60;

interface UploadTokenPayload {
  kind: 'recording_upload';
  rid: string;
  cid: string;
}

/**
 * 로그인 토큰과 다른 키로 서명한다 — 업로드 토큰이 일반 API 인증으로
 * 통하는 일(또는 그 반대)이 원천적으로 없게.
 */
const uploadSecret = (secret: string) => `${secret}:recording-upload`;

export function signUploadToken(recordingId: string, coachId: string, secret: string): string {
  const payload: UploadTokenPayload = { kind: 'recording_upload', rid: recordingId, cid: coachId };
  return jwt.sign(payload, uploadSecret(secret), { expiresIn: UPLOAD_TOKEN_TTL_SEC });
}

/** 유효하면 { recordingId, coachId }, 아니면 null. */
export function verifyUploadToken(
  token: string,
  secret: string
): { recordingId: string; coachId: string } | null {
  try {
    const p = jwt.verify(token, uploadSecret(secret)) as Partial<UploadTokenPayload>;
    if (p.kind !== 'recording_upload' || !p.rid || !p.cid) return null;
    return { recordingId: p.rid, coachId: p.cid };
  } catch {
    return null;
  }
}
