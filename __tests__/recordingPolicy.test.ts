import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import {
  AUDIO_RETENTION_MS,
  HOUR_MS,
  audioExpiresAt,
  canKeep,
  effectivePlan,
  isValidSeq,
  missingSegments,
  segmentKey,
  signUploadToken,
  statusAfterComplete,
  verifyUploadToken,
} from '../server/src/services/recordingPolicy';

// jsonwebtoken 은 서버 의존성이다 — 정책 모듈과 같은 사본을 쓴다.
const jwt = createRequire(path.resolve(__dirname, '../server/package.json'))('jsonwebtoken');

describe('원본 보관 기간', () => {
  it('종료 3일 뒤 만료된다', () => {
    expect(AUDIO_RETENTION_MS).toBe(3 * 24 * HOUR_MS);
    expect(audioExpiresAt(1_000)).toBe(1_000 + AUDIO_RETENTION_MS);
  });
});

describe('effectivePlan', () => {
  const now = Date.parse('2026-11-16T00:00:00Z');
  it('구독이 꺼져 있으면 FREE', () => {
    expect(effectivePlan({ is_subscribed: false, subscription_plan: 'PRO' }, now)).toBe('FREE');
  });
  it('만료일이 지났으면 FREE', () => {
    expect(
      effectivePlan(
        { is_subscribed: true, subscription_plan: 'PRO', subscription_end_date: '2026-11-01' },
        now
      )
    ).toBe('FREE');
  });
  it('유효한 상위 플랜을 그대로 쓴다', () => {
    expect(
      effectivePlan(
        { is_subscribed: true, subscription_plan: 'pro_plus', subscription_end_date: '2026-12-31' },
        now
      )
    ).toBe('PRO_PLUS');
  });
  it('모르는 플랜 이름은 FREE', () => {
    expect(effectivePlan({ is_subscribed: true, subscription_plan: 'GOLD' }, now)).toBe('FREE');
  });
});

describe('canKeep — 플랜별 보관 한도', () => {
  it('PRO 는 20시간까지 보관된다', () => {
    expect(canKeep('PRO', 19 * HOUR_MS, HOUR_MS)).toEqual({ ok: true });
  });
  it('한도를 넘으면 다음 플랜을 안내한다', () => {
    expect(canKeep('PRO', 19.5 * HOUR_MS, HOUR_MS)).toEqual({
      ok: false,
      reason: 'quota_exceeded',
      usedMs: 19.5 * HOUR_MS,
      limitMs: 20 * HOUR_MS,
      nextPlan: 'PRO_PLUS',
    });
  });
  it('FREE 는 보관할 수 없다', () => {
    const d = canKeep('FREE', 0, 60_000);
    expect(d.ok).toBe(false);
  });
  it('최상위 플랜은 다음 플랜이 없다', () => {
    const d = canKeep('PRO_MAX', 500 * HOUR_MS, 1);
    expect(d.ok === false && d.nextPlan).toBeNull();
  });
});

describe('세그먼트', () => {
  it('순번 범위를 검사한다', () => {
    expect(isValidSeq(0)).toBe(true);
    expect(isValidSeq(599)).toBe(true);
    expect(isValidSeq(600)).toBe(false);
    expect(isValidSeq(-1)).toBe(false);
    expect(isValidSeq(1.5)).toBe(false);
  });
  it('빠진 순번을 찾는다', () => {
    expect(missingSegments(5, [0, 1, 3])).toEqual([2, 4]);
    expect(missingSegments(0, [])).toEqual([]);
  });
  it('다 모이면 처리 대기, 아니면 업로드 대기', () => {
    expect(statusAfterComplete(3, [0, 1, 2])).toBe('queued');
    expect(statusAfterComplete(3, [0, 2])).toBe('uploading');
  });
  it('R2 키는 순번이 정렬되게 0으로 채운다', () => {
    expect(segmentKey('c1', 'r1', 7)).toBe('recordings/c1/r1/seg-0007.m4a');
  });
});

describe('업로드 토큰', () => {
  const secret = 'test-secret';
  it('발급한 토큰을 검증한다', () => {
    const t = signUploadToken('rec-1', 'coach-1', secret);
    expect(verifyUploadToken(t, secret)).toEqual({ recordingId: 'rec-1', coachId: 'coach-1' });
  });
  it('로그인 토큰은 업로드 토큰으로 통하지 않는다', () => {
    const login = jwt.sign({ id: 'coach-1', role: 'coach' }, secret);
    expect(verifyUploadToken(login, secret)).toBeNull();
  });
  it('업로드 토큰은 로그인 토큰으로 통하지 않는다', () => {
    const t = signUploadToken('rec-1', 'coach-1', secret);
    expect(() => jwt.verify(t, secret)).toThrow();
  });
});
