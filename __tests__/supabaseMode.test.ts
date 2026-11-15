/**
 * Supabase 모드(이전 1단계)의 앱 쪽 규칙:
 *  - ?supabase=1/0 으로 켜고 끄며 기기에 기억한다.
 *  - AI 는 Supabase 모드에서 Edge Function 으로, Supabase 로그인 토큰을 싣고 간다.
 *  - 레슨 ↔ DB 행 변환이 Express(server/src/routes/lessons.ts)와 같은 열을 쓴다.
 *  - 공유 토큰 모양으로 어느 백엔드에 노트를 물을지 고른다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/supabaseClient', () => ({
  getSupabase: vi.fn(),
  getSupabaseAccessToken: vi.fn(async () => 'sb-coach-jwt'),
}));

import {
  isSupabaseMode,
  isSupabaseNoteToken,
  SUPABASE_URL,
  syncSupabaseModeFromUrl,
} from '../utils/supabaseMode';
import { resolveAiTarget } from '../services/aiTarget';
import { lessonToRow, rowToLesson } from '../services/supabaseCoachStore';
import type { Lesson } from '../types';

afterEach(() => {
  syncSupabaseModeFromUrl('?supabase=0');
  localStorage.removeItem('swingnote_api_token');
});

describe('Supabase mode flag', () => {
  it('turns on with ?supabase=1, stays on, and turns off with ?supabase=0', () => {
    expect(isSupabaseMode()).toBe(false);
    expect(syncSupabaseModeFromUrl('?supabase=1')).toBe(true);
    expect(syncSupabaseModeFromUrl('')).toBe(true);
    expect(syncSupabaseModeFromUrl('?supabase=0')).toBe(false);
    expect(isSupabaseMode()).toBe(false);
  });

  it('tells Supabase share tokens (64 hex) from Express ones (22 base64url)', () => {
    expect(isSupabaseNoteToken('a'.repeat(64))).toBe(true);
    expect(isSupabaseNoteToken('AbCdEfGhIjKlMnOpQrStUv')).toBe(false);
  });
});

describe('AI target', () => {
  it('uses the Express gateway with the server token by default', async () => {
    localStorage.setItem('swingnote_api_token', 'express-jwt');
    const t = await resolveAiTarget();
    expect(t.url).toMatch(/\/api\/ai\/invoke$/);
    expect(t.headers.Authorization).toBe('Bearer express-jwt');
  });

  it('uses the ai-invoke Edge Function with the Supabase token in Supabase mode', async () => {
    syncSupabaseModeFromUrl('?supabase=1');
    const t = await resolveAiTarget();
    expect(t.url).toBe(`${SUPABASE_URL}/functions/v1/ai-invoke`);
    expect(t.headers.Authorization).toBe('Bearer sb-coach-jwt');
    expect(t.headers.apikey).toBeTruthy();
  });
});

describe('lesson ↔ row mapping', () => {
  const lesson = {
    id: '',
    clientName: '김고객',
    clientPhone: '01012345678',
    coachId: 'ignored-by-row',
    createdBy: 'COACH',
    recordType: 'LIVE_LESSON',
    date: '2026-11-15',
    title: '오른팔 정리',
    videoUrl: '',
    mediaType: 'audio',
    coachNotes: '',
    aiAnalysis: '요약',
    tags: [],
    createdAt: 1,
    visibility: 'everyone',
    liveLessonDetail: { clientNote: { headline: 'h', keyPoints: ['k'] } },
  } as unknown as Lesson;

  it('writes only editable columns, never ownership / coach / share fields', () => {
    const row = lessonToRow(lesson);
    expect(row).toMatchObject({
      client_name: '김고객',
      client_phone: '01012345678',
      record_type: 'LIVE_LESSON',
      live_lesson_detail: { clientNote: { headline: 'h', keyPoints: ['k'] } },
    });
    for (const col of ['id', 'coach_id', 'created_at', 'ownership', 'original_coach_id', 'share_token']) {
      expect(row).not.toHaveProperty(col);
    }
  });

  it('applies the Express rules: name_phone client key, visibility whitelist', () => {
    const row = lessonToRow(lesson);
    expect(row.client_id).toBe('김고객_01012345678');
    expect(row.visibility).toBe('coach');
  });

  it('reads a row back into the same lesson shape', () => {
    const back = rowToLesson({
      id: 'l1',
      coach_id: 'c1',
      created_at: '1',
      updated_at: '2',
      ownership: 'shared',
      ...lessonToRow(lesson),
    });
    expect(back).toMatchObject({
      id: 'l1',
      coachId: 'c1',
      createdAt: 1,
      clientName: '김고객',
      recordType: 'LIVE_LESSON',
      liveLessonDetail: { clientNote: { headline: 'h' } },
    });
  });
});
