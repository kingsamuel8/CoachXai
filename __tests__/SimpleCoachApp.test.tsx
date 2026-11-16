/**
 * 단순 코치 화면 — 녹음 → 정리 → 전달.
 *
 * 녹음 화면(LiveLessonCompanion)은 자체 테스트가 있으므로 여기서는 스텁으로
 * 바꾸고, 그 앞뒤의 흐름을 본다: 고객 고르기 → 녹음 끝 → 고객용 노트 자동
 * 정리·수정 → 저장 + 공유 링크 → 보내기.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../components/LiveLessonCompanion', () => ({
  LiveLessonCompanion: (props: {
    studentName: string;
    onFinish: (clips: unknown[], handoff?: unknown) => void;
    onCancel: () => void;
  }) => (
    <div>
      <p>recording {props.studentName}</p>
      <button
        type="button"
        onClick={() =>
          props.onFinish([], {
            sessionId: 's1',
            recordedDurationSec: 600,
            noteCount: 3,
            pendingCount: 0,
            editedTranscript: '코치: 백스윙 탑에서 왼팔을 펴세요\n학생: 네',
            editedSummary: '**코치 요약**\n- 왼팔 펴기',
            editedCoachSummary: '- 왼팔 펴기',
          })
        }
      >
        finish
      </button>
      <button type="button" onClick={() => props.onFinish([], undefined)}>
        finish-empty
      </button>
    </div>
  ),
}));

vi.mock('../services/lessonClientNote', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/lessonClientNote')>()),
  generateClientNote: vi.fn(async ({ language }: { language: string }) => ({
    language,
    headline: language === 'en' ? 'Backswing day' : '백스윙 정리',
    keyPoints: ['왼팔 펴기', '코킹 유지'],
    drills: ['빈스윙 20회'],
    nextFocus: '다운스윙 순서',
    message: '',
  })),
}));

vi.mock('../services/apiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/apiService')>()),
  apiService: {
    saveLesson: vi.fn(async (l: Record<string, unknown>) => ({ ...l, id: 'lesson-1' })),
    shareLesson: vi.fn(async () => ({ token: 'AbCdEfGhIjKlMnOpQrSt12' })),
  },
}));

vi.mock('../services/notificationPreferenceService', () => ({
  notifyLessonUploaded: vi.fn(async () => {}),
}));

import { LanguageProvider } from '../components/LanguageContext';
import { SimpleCoachApp } from '../components/simple/SimpleCoachApp';
import { apiService } from '../services/apiService';
import { generateClientNote } from '../services/lessonClientNote';
import type { Lesson } from '../types';

const renderApp = (overrides: Partial<React.ComponentProps<typeof SimpleCoachApp>> = {}) => {
  const props: React.ComponentProps<typeof SimpleCoachApp> = {
    coach: { id: 'coach-1', name: '김코치' },
    students: [{ id: 'c1', name: '한윤슬', phone: '01012345678' }],
    lessons: [],
    onLessonSaved: vi.fn(),
    onOpenFullApp: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  };
  render(
    <LanguageProvider>
      <SimpleCoachApp {...props} />
    </LanguageProvider>
  );
  return props;
};

describe('SimpleCoachApp', () => {
  beforeEach(() => {
    localStorage.removeItem('coachxai_language');
    vi.clearAllMocks();
  });

  it('고객 이름을 정해야 녹음을 시작할 수 있다', () => {
    renderApp();
    const start = screen.getByRole('button', { name: /레슨 녹음 시작/ });
    expect(start).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '한윤슬' }));
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(screen.getByText('recording 한윤슬')).toBeInTheDocument();
  });

  it('녹음 → 정리 → 전달: 고객용 노트를 저장하고 공유 링크를 만든다', async () => {
    const props = renderApp();
    fireEvent.click(screen.getByRole('button', { name: '한윤슬' }));
    fireEvent.click(screen.getByRole('button', { name: /레슨 녹음 시작/ }));
    fireEvent.click(screen.getByRole('button', { name: 'finish' }));

    // 정리: 필기로 고객용 노트를 자동으로 만든다.
    expect(await screen.findByDisplayValue('백스윙 정리')).toBeInTheDocument();
    expect(generateClientNote).toHaveBeenCalledWith(
      expect.objectContaining({
        studentName: '한윤슬',
        language: 'ko',
        transcript: expect.stringContaining('왼팔을 펴세요'),
        coachSummary: '- 왼팔 펴기',
      })
    );

    // 코치가 고친다.
    fireEvent.change(screen.getByDisplayValue('백스윙 정리'), {
      target: { value: '오늘은 백스윙 탑' },
    });

    fireEvent.click(screen.getByRole('button', { name: /저장하고 보내기/ }));

    // 전달: 링크가 준비된 화면.
    expect(await screen.findByText('레슨 노트가 준비됐어요')).toBeInTheDocument();
    expect(screen.getByText(/\?note=AbCdEfGhIjKlMnOpQrSt12/)).toBeInTheDocument();

    const saved = vi.mocked(apiService.saveLesson).mock.calls[0][0] as Lesson;
    expect(saved).toMatchObject({
      clientName: '한윤슬',
      clientPhone: '01012345678', // 회원을 고르면 회원 앱과도 이어진다
      coachId: 'coach-1',
      recordType: 'LIVE_LESSON',
      createdBy: 'COACH',
    });
    expect(saved.liveLessonDetail?.clientNote).toMatchObject({
      language: 'ko',
      headline: '오늘은 백스윙 탑',
      keyPoints: ['왼팔 펴기', '코킹 유지'],
      drills: ['빈스윙 20회'],
    });
    expect(saved.liveLessonDetail?.transcript.map((t) => t.text)).toEqual(
      expect.arrayContaining([expect.stringContaining('왼팔을 펴세요')])
    );
    expect(apiService.shareLesson).toHaveBeenCalledWith('lesson-1');
    expect(props.onLessonSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'lesson-1' }));
  });

  it('보내기를 누르면 휴대폰 공유 창에 노트 본문과 링크를 넘긴다', async () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    try {
      renderApp();
      fireEvent.click(screen.getByRole('button', { name: '한윤슬' }));
      fireEvent.click(screen.getByRole('button', { name: /레슨 녹음 시작/ }));
      fireEvent.click(screen.getByRole('button', { name: 'finish' }));
      await screen.findByDisplayValue('백스윙 정리');
      fireEvent.click(screen.getByRole('button', { name: /저장하고 보내기/ }));
      fireEvent.click(await screen.findByRole('button', { name: /고객에게 보내기/ }));
      await waitFor(() => expect(share).toHaveBeenCalled());
      const payload = (share.mock.calls[0] as unknown as [{ text: string }])[0];
      expect(payload.text).toContain('백스윙 정리');
      expect(payload.text).toContain('• 왼팔 펴기');
      expect(payload.text).toContain('?note=AbCdEfGhIjKlMnOpQrSt12');
    } finally {
      delete (navigator as { share?: unknown }).share;
    }
  });

  it('노트 언어를 바꿔 다시 정리할 수 있다(고객 언어로 보내기)', async () => {
    renderApp();
    fireEvent.change(screen.getByPlaceholderText('고객 이름'), { target: { value: 'Emma' } });
    fireEvent.click(screen.getByRole('button', { name: /레슨 녹음 시작/ }));
    fireEvent.click(screen.getByRole('button', { name: 'finish' }));
    await screen.findByDisplayValue('백스윙 정리');
    fireEvent.change(screen.getByLabelText('노트 언어'), { target: { value: 'en' } });
    fireEvent.click(screen.getByRole('button', { name: /이 언어로 다시 정리/ }));
    expect(await screen.findByDisplayValue('Backswing day')).toBeInTheDocument();
    expect(generateClientNote).toHaveBeenLastCalledWith(expect.objectContaining({ language: 'en' }));
  });

  it('녹음된 게 없으면 홈으로 돌아와 알린다', () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: '한윤슬' }));
    fireEvent.click(screen.getByRole('button', { name: /레슨 녹음 시작/ }));
    fireEvent.click(screen.getByRole('button', { name: 'finish-empty' }));
    expect(screen.getByRole('alert')).toHaveTextContent('녹음된 내용이 없어');
  });

  it('보낸 노트 목록에서 다시 열어 보낼 수 있다', async () => {
    renderApp({
      lessons: [
        {
          id: 'old-1',
          clientName: '한윤슬',
          clientPhone: '',
          createdBy: 'COACH',
          date: '2026-11-01',
          title: '지난 레슨',
          videoUrl: '',
          mediaType: 'audio',
          coachNotes: '',
          tags: [],
          createdAt: 0,
          liveLessonDetail: {
            recordedDurationSec: 0,
            transcript: [],
            clientNote: {
              language: 'ko',
              headline: '그립 압력 줄이기',
              keyPoints: ['그립은 가볍게'],
              drills: [],
              nextFocus: '',
              message: '',
            },
          },
        } as Lesson,
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /그립 압력 줄이기/ }));
    expect(await screen.findByText('레슨 노트가 준비됐어요')).toBeInTheDocument();
    expect(apiService.shareLesson).toHaveBeenCalledWith('old-1');
  });

  it('설정에서 전체 기능 화면으로 갈 수 있다', () => {
    const props = renderApp();
    fireEvent.click(screen.getByRole('button', { name: '설정' }));
    fireEvent.click(screen.getByRole('button', { name: '전체 기능 화면으로' }));
    expect(props.onOpenFullApp).toHaveBeenCalled();
  });

  it('앱 언어를 영어로 바꾸면 화면이 영어가 되고 다음 실행에도 남는다', () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: '설정' }));
    fireEvent.change(screen.getByDisplayValue('한국어'), { target: { value: 'en' } });
    expect(screen.getByRole('button', { name: /Start recording/ })).toBeInTheDocument();
    expect(localStorage.getItem('coachxai_language')).toBe('en');
  });
});
