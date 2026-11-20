/**
 * 레슨 녹음 v2 서버 API 클라이언트 (server/src/routes/recordings.ts).
 */
import { apiRequest, ApiError } from '../apiService';

export type RecordingStatus = 'recording' | 'uploading' | 'queued' | 'processing' | 'ready' | 'failed';
export type CoachPlan = 'FREE' | 'PRO' | 'PRO_PLUS' | 'PRO_MAX';

export interface Recording {
  id: string;
  clientId: string | null;
  clientName: string | null;
  lessonId: string | null;
  status: RecordingStatus;
  segmentCount: number | null;
  uploadedSegments?: number;
  missingSegments?: number[];
  durationMs: number | null;
  bytes: number;
  startedAt: number;
  endedAt: number | null;
  /** 원본이 삭제될 시각. 보관 중이면 null. */
  audioExpiresAt: number | null;
  kept: boolean;
  audioDeleted: boolean;
  error: string | null;
  /** 구조화 요약(마크다운). 처리 전이거나 말소리가 없으면 null. */
  summary: string | null;
  summaryModel: string | null;
  processedAt: number | null;
  attempts: number;
}

export interface TranscriptSegment {
  idx: number;
  startMs: number;
  endMs: number;
  speaker: string;
  /** 받아쓰기 엔진 원문 — 바뀌지 않는다. */
  rawText: string;
  /** 표시용(코치 수정 반영). */
  text: string;
  editedByCoach: boolean;
}

export interface RecordingGap {
  startMs: number;
  endMs: number | null;
  reason: string;
}

export interface StorageUsage {
  plan: CoachPlan;
  usedMs: number;
  limitMs: number;
  nextPlan: CoachPlan | null;
}

export const createRecording = (input: {
  clientId?: string;
  clientName?: string;
  lessonId?: string;
  startedAt?: number;
  mimeType?: string;
}) =>
  apiRequest<{ recording: Recording; uploadToken: string; uploadTokenExpiresAt: number }>(
    'POST',
    '/api/recordings',
    input
  );

export const getRecording = (id: string) =>
  apiRequest<{ recording: Recording; gaps: RecordingGap[] }>('GET', `/api/recordings/${id}`);

export const getTranscript = (id: string) =>
  apiRequest<{ segments: TranscriptSegment[] }>('GET', `/api/recordings/${id}/transcript`);

/** 실패한 처리(받아쓰기·요약)를 다시 대기열에 올린다. 원본이 남아 있을 때만. */
export const retryRecording = (id: string) =>
  apiRequest<{ recording: Recording }>('POST', `/api/recordings/${id}/retry`);

export const getStorageUsage = () => apiRequest<StorageUsage>('GET', '/api/recordings/storage');

export type KeepResult =
  | { ok: true; recording: Recording }
  | { ok: false; reason: 'quota_exceeded'; usage: StorageUsage };

/** 원본 보관. 한도를 넘으면 상위 플랜 안내에 쓸 사용량을 돌려준다. */
export async function keepRecording(id: string): Promise<KeepResult> {
  try {
    const { recording } = await apiRequest<{ recording: Recording }>(
      'POST',
      `/api/recordings/${id}/keep`
    );
    return { ok: true, recording };
  } catch (err) {
    if (err instanceof ApiError && err.status === 402) {
      return { ok: false, reason: 'quota_exceeded', usage: await getStorageUsage() };
    }
    throw err;
  }
}

export const unkeepRecording = (id: string) =>
  apiRequest<{ recording: Recording }>('DELETE', `/api/recordings/${id}/keep`);

/** 보관 시간 표시용: 14.2 / 20시간 */
export const formatHours = (ms: number): string => {
  const h = ms / 3_600_000;
  return h >= 10 ? `${Math.round(h)}` : `${Math.round(h * 10) / 10}`;
};
