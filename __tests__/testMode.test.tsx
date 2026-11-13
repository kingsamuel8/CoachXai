/**
 * 테스트 모드 — 서버 없이 녹음 → 정리 → 전달.
 * 지키는 계약:
 *  - AI 호출은 서버가 아니라 Gemini 로 직접 간다(서버와 같은 모델·요청 모양).
 *  - 레슨은 이 기기에 저장되고, 자리가 모자라면 오래된 필기부터 비운다.
 *  - 전달 링크는 노트를 담고(서버 없이 열림), 필기·전화번호는 담지 않는다.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../components/LiveLessonCompanion', () => ({
  LiveLessonCompanion: (props: { onFinish: (c: unknown[], h?: unknown) => void }) => (
    <button
      type="button"
      onClick={() =>
        props.onFinish([], {
          sessionId: 's1',
          recordedDurationSec: 300,
          noteCount: 1,
          pendingCount: 0,
          editedTranscript: '코치: 다운블로로 눌러 치세요',
          editedCoachSummary: '- 다운블로',
        })
      }
    >
      finish
    </button>
  ),
}));

import { invokeBackendAI } from '../services/geminiService';
import { buildGeminiRequestBody, callGeminiDirect, modelForFeature } from '../services/testGemini';
import { listTestLessons, saveTestLesson } from '../services/testLessonStore';
import { decodeNoteLink, encodeNoteLink } from '../utils/noteLink';
import { setTestGeminiKey, syncTestModeFromUrl, isTestMode } from '../utils/testMode';
import { TestModeApp } from '../components/simple/TestModeApp';
import type { Lesson } from '../types';

const okResponse = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    status: 200,
  });

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('테스트 모드 켜고 끄기', () => {
  it('?test=1 로 켜지고 기기에 기억되며 ?test=0 으로 꺼진다', () => {
    expect(isTestMode()).toBe(false);
    expect(syncTestModeFromUrl('?test=1')).toBe(true);
    expect(syncTestModeFromUrl('')).toBe(true);
    expect(syncTestModeFromUrl('?test=0')).toBe(false);
  });
});

describe('Gemini 직접 호출', () => {
  it('서버와 같은 모델로 라우팅한다', () => {
    expect(modelForFeature('lesson_audio_precise_transcribe')).toBe('gemini-3.1-pro-preview');
    expect(modelForFeature('lesson_client_note')).toBe('gemini-3.1-pro-preview');
    expect(modelForFeature('lesson_audio_live_transcribe')).toBe('gemini-3.6-flash');
    expect(modelForFeature('something_else')).toBe('gemini-2.5-flash');
  });

  it('프롬프트·오디오·스키마·온도를 서버와 같은 모양으로 싣는다', () => {
    const body = buildGeminiRequestBody('lesson_audio_term_verify', {
      prompt: 'P',
      mediaParts: [{ inlineData: { data: 'AAA', mimeType: 'audio/webm' } }],
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT' },
    }) as {
      contents: Array<{ parts: unknown[] }>;
      generationConfig: Record<string, unknown>;
    };
    expect(body.contents[0].parts).toEqual([
      { text: 'P' },
      { inline_data: { data: 'AAA', mime_type: 'audio/webm' } },
    ]);
    expect(body.generationConfig).toEqual({
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT' },
      temperature: 0.1,
    });
  });

  it('키가 없으면 분명하게 실패한다', async () => {
    await expect(callGeminiDirect('lesson_client_note', { prompt: 'x' })).rejects.toThrow(/API 키/);
  });

  it('키를 헤더로 보내고, 모델이 없으면(404) 기본 모델로 한 번 바꾼다', async () => {
    setTestGeminiKey('test-key');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(okResponse('{"ok":1}'));
    expect(await callGeminiDirect('lesson_client_note', { prompt: 'x' })).toBe('{"ok":1}');
    expect(String(fetchMock.mock.calls[0][0])).toContain('gemini-3.1-pro-preview');
    expect(String(fetchMock.mock.calls[1][0])).toContain('gemini-2.5-flash');
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('test-key');
  });

  it('잘못된 키(400·403)는 다시 시도하지 않는다', async () => {
    setTestGeminiKey('bad');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('API key not valid', { status: 400 }));
    await expect(callGeminiDirect('lesson_client_note', { prompt: 'x' })).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('테스트 모드에서는 invokeBackendAI 가 서버 대신 Gemini 로 간다', async () => {
    syncTestModeFromUrl('?test=1');
    setTestGeminiKey('test-key');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse('답'));
    expect(await invokeBackendAI('lesson_client_note', { prompt: 'x' })).toBe('답');
    expect(String(fetchMock.mock.calls[0][0])).toContain('generativelanguage.googleapis.com');
  });
});

describe('노트 링크', () => {
  it('노트를 링크에 담고 그대로 되읽는다(한글 포함)', () => {
    const url = encodeNoteLink({
      coachName: '김코치',
      studentName: '한윤슬',
      date: '2026-11-13',
      note: {
        language: 'ko',
        headline: '다운블로 연습',
        keyPoints: ['손이 공보다 앞에'],
        drills: ['하프 스윙 30회'],
        nextFocus: '',
        message: '수고했어요',
      },
    });
    const hash = url.slice(url.indexOf('#'));
    expect(hash).toMatch(/^#note=[A-Za-z0-9_-]+$/);
    expect(decodeNoteLink(hash)).toMatchObject({
      coachName: '김코치',
      studentName: '한윤슬',
      note: { headline: '다운블로 연습', keyPoints: ['손이 공보다 앞에'] },
    });
  });

  it('깨진 링크는 null', () => {
    expect(decodeNoteLink('#note=!!!')).toBeNull();
    expect(decodeNoteLink('#note=aGVsbG8')).toBeNull(); // JSON 이 아님
    expect(decodeNoteLink('')).toBeNull();
  });
});

describe('기기 저장소', () => {
  const lesson = (over: Partial<Lesson> = {}): Lesson =>
    ({
      id: '',
      clientName: 'A',
      clientPhone: '',
      createdBy: 'COACH',
      date: '2026-11-13',
      title: 't',
      videoUrl: '',
      mediaType: 'audio',
      coachNotes: '',
      tags: [],
      createdAt: 0,
      liveLessonDetail: { recordedDurationSec: 1, transcript: [{ startSec: 0, text: '필기' }] },
      ...over,
    }) as Lesson;

  it('id 를 붙여 저장하고 최신 순으로 돌려준다', () => {
    const a = saveTestLesson(lesson({ title: 'first' }));
    const b = saveTestLesson(lesson({ title: 'second' }));
    expect(a.id).toBeTruthy();
    expect(listTestLessons().map((l) => l.title)).toEqual(['second', 'first']);
    expect(b.createdAt).toBeGreaterThan(0);
  });

  it('자리가 모자라면 오래된 레슨의 필기부터 비우고 새 레슨은 지킨다', () => {
    saveTestLesson(lesson({ title: 'old' }));
    const realSet = Storage.prototype.setItem;
    let calls = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k, v) {
      calls += 1;
      if (calls === 1) throw new DOMException('full', 'QuotaExceededError');
      return realSet.call(this, k, v);
    });
    saveTestLesson(lesson({ title: 'new' }));
    const [newest, oldest] = listTestLessons();
    expect(newest.title).toBe('new');
    expect(newest.liveLessonDetail?.transcript).toHaveLength(1);
    expect(oldest.liveLessonDetail?.transcript).toEqual([]);
  });
});

describe('TestModeApp', () => {
  it('설정 → 녹음 → 정리 → 전달: 기기에 저장하고 노트가 담긴 링크를 만든다', async () => {
    syncTestModeFromUrl('?test=1');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      okResponse(
        JSON.stringify({
          headline: '다운블로 연습',
          keyPoints: ['손이 공보다 앞에'],
          drills: [],
          nextFocus: '',
          message: '',
        })
      )
    );
    render(<TestModeApp />);

    const start = screen.getByRole('button', { name: '테스트 시작' });
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByLabelText('코치 이름'), { target: { value: '김코치' } });
    fireEvent.change(screen.getByLabelText('Gemini API 키'), { target: { value: 'test-key' } });
    fireEvent.click(start);

    expect(screen.getByText(/테스트 모드 · 서버에 저장되지 않고/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('고객 이름'), { target: { value: '한윤슬' } });
    fireEvent.click(screen.getByRole('button', { name: /레슨 녹음 시작/ }));
    fireEvent.click(screen.getByRole('button', { name: 'finish' }));

    expect(await screen.findByDisplayValue('다운블로 연습')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /저장하고 보내기/ }));
    expect(await screen.findByText('레슨 노트가 준비됐어요')).toBeInTheDocument();

    const link = screen.getByText(/#note=/).textContent ?? '';
    const decoded = decodeNoteLink(link.slice(link.indexOf('#')));
    expect(decoded).toMatchObject({
      coachName: '김코치',
      studentName: '한윤슬',
      note: { headline: '다운블로 연습' },
    });
    // 링크에는 필기 전문이 담기지 않는다.
    expect(JSON.stringify(decoded)).not.toContain('눌러 치세요');

    const saved = listTestLessons();
    expect(saved).toHaveLength(1);
    expect(saved[0].liveLessonDetail?.clientNote?.headline).toBe('다운블로 연습');
  });
});
