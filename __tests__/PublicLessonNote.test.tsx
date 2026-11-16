/**
 * 공유 링크로 고객이 여는 레슨 노트 — 로그인 없이, 노트만.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../services/apiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/apiService')>()),
  apiService: { getPublicLessonNote: vi.fn() },
}));

import { apiService } from '../services/apiService';
import { PublicLessonNote } from '../components/simple/PublicLessonNote';

describe('PublicLessonNote', () => {
  it('노트 언어의 소제목으로 핵심·연습 과제·다음 레슨을 보여 준다', async () => {
    vi.mocked(apiService.getPublicLessonNote).mockResolvedValueOnce({
      coachName: 'Kim',
      studentName: 'Emma',
      date: '2026-11-13',
      note: {
        language: 'en',
        headline: 'Backswing day',
        keyPoints: ['Straight left arm', 'Hold the wrist hinge'],
        drills: ['20 slow swings'],
        nextFocus: 'Downswing sequence',
        message: 'Great work today',
      },
      fallbackSummary: '',
    });
    render(<PublicLessonNote token="AbCdEfGhIjKlMnOpQrSt12" />);
    expect(await screen.findByRole('heading', { name: 'Backswing day' })).toBeInTheDocument();
    expect(screen.getByText('For Emma · Coach Kim')).toBeInTheDocument();
    expect(screen.getByText('Key points')).toBeInTheDocument();
    expect(screen.getByText('Hold the wrist hinge')).toBeInTheDocument();
    expect(screen.getByText('Practice')).toBeInTheDocument();
    expect(screen.getByText('Downswing sequence')).toBeInTheDocument();
    expect(screen.getByText('Great work today')).toBeInTheDocument();
  });

  it('고객용 노트가 없는 옛 기록은 코치 요약을 보여 준다', async () => {
    vi.mocked(apiService.getPublicLessonNote).mockResolvedValueOnce({
      coachName: '김',
      studentName: '이',
      date: '2026-11-01',
      note: null,
      fallbackSummary: '- 그립 압력 줄이기',
    });
    render(<PublicLessonNote token="AbCdEfGhIjKlMnOpQrSt12" />);
    expect(await screen.findByText('- 그립 압력 줄이기')).toBeInTheDocument();
  });

  it('없는 링크는 다시 받으라고 안내한다', async () => {
    vi.mocked(apiService.getPublicLessonNote).mockRejectedValueOnce(
      Object.assign(new Error('Not found'), { status: 404 })
    );
    render(<PublicLessonNote token="AbCdEfGhIjKlMnOpQrSt12" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/new link|다시 받아/);
  });
});
