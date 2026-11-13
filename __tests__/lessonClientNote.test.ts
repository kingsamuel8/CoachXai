/**
 * 고객용 레슨 노트 — 서비스가 고객에게 내놓는 결과물.
 * 지키는 계약: 고객 언어로 쓰라고 지시한다, 필기에 없는 것을 지어내지 말라고
 * 지시한다, 응답이 흔들려도 안전한 노트 모양으로 정규화한다, 메신저로 보낼
 * 문자에 노트 본문과 링크가 모두 실린다.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/geminiService', () => ({
  invokeBackendAI: vi.fn(),
  getResponseText: (r: unknown) => (typeof r === 'string' ? r : null),
}));

import { invokeBackendAI } from '../services/geminiService';
import {
  buildClientNotePrompt,
  formatClientNoteMessage,
  generateClientNote,
  parseClientNoteResponse,
} from '../services/lessonClientNote';
import { lessonNoteUrl, readLessonNoteToken } from '../utils/publicAppUrl';

describe('buildClientNotePrompt', () => {
  it('고객 언어로, 필기에 있는 것만 쓰라고 지시하고 코치 요약을 싣는다', () => {
    const prompt = buildClientNotePrompt({
      studentName: 'Emma',
      coachName: 'Kim',
      language: 'ja',
      transcript: '코치: 백스윙 탑에서 왼팔을 펴세요',
      coachSummary: '- 왼팔 펴기',
    });
    expect(prompt).toContain('日本語');
    expect(prompt).toContain('Emma');
    expect(prompt).toContain('백스윙 탑에서 왼팔을 펴세요');
    expect(prompt).toContain('- 왼팔 펴기');
    expect(prompt).toContain('Do not invent');
  });

  it('아주 긴 필기는 앞뒤를 남기고 줄인다', () => {
    const transcript = `시작${'가'.repeat(100_000)}끝`;
    const prompt = buildClientNotePrompt({
      studentName: 'A',
      coachName: 'B',
      language: 'en',
      transcript,
    });
    expect(prompt.length).toBeLessThan(70_000);
    expect(prompt).toContain('시작');
    expect(prompt).toContain('끝');
  });
});

describe('parseClientNoteResponse', () => {
  it('응답을 노트 모양으로 정규화한다', () => {
    const note = parseClientNoteResponse(
      '```json\n{"headline":" 백스윙 정리 ","keyPoints":["왼팔 펴기","",3],"drills":["빈스윙 20회"],"nextFocus":"다운스윙","message":"좋았어요"}\n```',
      'ko'
    );
    expect(note).toEqual({
      language: 'ko',
      headline: '백스윙 정리',
      keyPoints: ['왼팔 펴기'],
      drills: ['빈스윙 20회'],
      nextFocus: '다운스윙',
      message: '좋았어요',
    });
  });

  it('내용이 없거나 JSON 이 아니면 null', () => {
    expect(parseClientNoteResponse('{"headline":"","keyPoints":[]}', 'en')).toBeNull();
    expect(parseClientNoteResponse('not json', 'en')).toBeNull();
  });
});

describe('generateClientNote', () => {
  it('고객용 노트 경로(lesson_client_note)로 부른다', async () => {
    vi.mocked(invokeBackendAI).mockResolvedValueOnce(
      JSON.stringify({ headline: 'Backswing', keyPoints: ['Straight left arm'], drills: [], nextFocus: '', message: '' }) as never
    );
    const note = await generateClientNote({
      studentName: 'Emma',
      coachName: 'Kim',
      language: 'en',
      transcript: 'coach: keep your left arm straight',
    });
    expect(vi.mocked(invokeBackendAI).mock.calls[0][0]).toBe('lesson_client_note');
    expect(note?.keyPoints).toEqual(['Straight left arm']);
  });

  it('필기도 코치 요약도 없으면 부르지 않는다', async () => {
    vi.mocked(invokeBackendAI).mockClear();
    expect(
      await generateClientNote({ studentName: 'A', coachName: 'B', language: 'en', transcript: ' ' })
    ).toBeNull();
    expect(invokeBackendAI).not.toHaveBeenCalled();
  });
});

describe('formatClientNoteMessage', () => {
  it('노트 언어의 소제목으로 본문과 링크를 모두 싣는다', () => {
    const text = formatClientNoteMessage(
      {
        language: 'en',
        headline: 'Backswing day',
        keyPoints: ['Straight left arm'],
        drills: ['20 slow swings'],
        nextFocus: 'Downswing sequence',
        message: 'Great work',
      },
      { coachName: 'Kim', studentName: 'Emma', date: '2026-11-13', url: 'https://x.test/?note=abc' }
    );
    expect(text).toContain('Lesson Notes · 2026-11-13');
    expect(text).toContain('For Emma — Coach Kim');
    expect(text).toContain('■ Key points\n• Straight left arm');
    expect(text).toContain('■ Practice\n• 20 slow swings');
    expect(text).toContain('■ Next lesson\nDownswing sequence');
    expect(text).toContain('https://x.test/?note=abc');
  });

  it('빈 칸은 소제목째 뺀다', () => {
    const text = formatClientNoteMessage(
      { language: 'ko', headline: '오늘은 그립', keyPoints: ['그립 압력 줄이기'], drills: [], nextFocus: '', message: '' },
      { coachName: '김', studentName: '이', date: '2026-11-13' }
    );
    expect(text).toContain('오늘의 핵심');
    expect(text).not.toContain('연습 과제');
    expect(text).not.toContain('다음 레슨');
  });
});

describe('공유 링크', () => {
  it('토큰을 쿼리로 싣고, 같은 모양만 다시 읽는다', () => {
    const url = lessonNoteUrl('AbCdEfGhIjKlMnOpQrSt12');
    expect(url).toMatch(/\/\?note=AbCdEfGhIjKlMnOpQrSt12$/);
    expect(readLessonNoteToken('?note=AbCdEfGhIjKlMnOpQrSt12')).toBe('AbCdEfGhIjKlMnOpQrSt12');
    expect(readLessonNoteToken('?note=short')).toBeNull();
    expect(readLessonNoteToken('?note=<script>alert(1)</script>xxxxxxxx')).toBeNull();
    expect(readLessonNoteToken('?invite=abc')).toBeNull();
  });

  it('로컬 개발 주소에서는 고객이 열 수 있는 배포 주소로 만든다', () => {
    // jsdom 의 주소는 localhost 다.
    expect(lessonNoteUrl('AbCdEfGhIjKlMnOpQrSt12').startsWith('https://coach-xai.vercel.app/')).toBe(true);
  });
});
