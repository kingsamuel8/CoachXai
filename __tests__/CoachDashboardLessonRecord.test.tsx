import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import App from '../App';

vi.mock('../services/firebase', () => ({
  firebaseService: {
    getSavedConfig: vi.fn().mockReturnValue(null),
    init: vi.fn().mockReturnValue(false),
    isInitialized: vi.fn().mockReturnValue(false),
    getLessons: vi.fn().mockResolvedValue([]),
    getClients: vi.fn().mockResolvedValue([]),
    getCoaches: vi.fn().mockResolvedValue([]),
    onAuthStateChanged: vi.fn().mockImplementation((_cb: (u: null) => void) => () => {}),
  },
}));

vi.mock('../services/storage', () => {
  const today = new Date().toISOString().slice(0, 10);
  const lessons = [
    {
      id: 'l1',
      clientName: '김회원',
      clientPhone: '010-1111-0001',
      coachId: 'coach1',
      createdBy: 'COACH',
      date: today,
      title: '드라이버 자세',
      videoUrl: '',
      mediaType: 'video',
      coachNotes: '',
      tags: [],
      createdAt: Date.now() - 1000,
    },
  ];
  const clients = [
    { id: 'c1', name: '김회원', phone: '010-1111-0001', coachId: 'coach1', email: '' },
  ];

  return {
    storageService: {
      // App claims the device cache for the signed-in account on load.
      applyCacheOwner: vi.fn().mockReturnValue(false),
      getCacheOwner: vi.fn().mockReturnValue(null),
      clearUserScopedData: vi.fn(),
      getLessons: vi.fn().mockReturnValue(lessons),
      getClients: vi.fn().mockReturnValue(clients),
      // 오프라인 폴백은 코치별 캐시(= 서버가 마지막으로 준 내 회원 명단)만 읽는다.
      getCoachClients: vi.fn().mockReturnValue(clients),
      saveCoachClients: vi.fn(),
      getCoaches: vi.fn().mockReturnValue([]),
      getLessonPackages: vi.fn().mockReturnValue([]),
      getTrainingPrograms: vi.fn().mockReturnValue([]),
      saveLessons: vi.fn(),
      saveClients: vi.fn(),
      saveCoaches: vi.fn(),
    },
  };
});

vi.mock('../services/authService', () => ({
  authService: {
    restoreSession: vi.fn().mockReturnValue({ role: 'COACH' }),
    getCoachProfile: vi.fn().mockReturnValue({
      id: 'coach1',
      name: '테스트코치',
      email: 'coach@test.com',
      phone: '010-0000-0000',
      branchId: 'branch1',
    }),
    saveCoachProfile: vi.fn(),
    renewSessionToken: vi.fn().mockResolvedValue(false),
    logout: vi.fn(),
  },
}));

vi.mock('../services/coachNotificationService', () => ({
  getUnreadReservationNotificationsForCoach: vi.fn().mockResolvedValue([]),
  markNotificationsAsRead: vi.fn().mockResolvedValue(undefined),
}));

// The diagnosis flow is feature-gated off by default in the
// companion-lesson-first relaunch; these shell tests cover the flow itself,
// so force the flag on.
vi.mock('../constants/featureFlags', () => ({
  FEATURES: {
    reservations: false,
    bayReservations: false,
    diagnosis: true,
    curriculum: false,
    automatedVideoEditing: false,
    swingAnalysisShortcut: false,
  },
}));

vi.mock('../components/CalendarView', () => ({
  default: () => <div data-testid="calendar-view" />,
}));

vi.mock('../components/CoachReservationNotificationModal', () => ({
  CoachReservationNotificationModal: () => null,
}));

const renderCoachApp = async () => {
  render(<App />);
  // Coach lands on CoachAIHome (the redesign home). Its header is bare
  // since the cleanup pass — no wordmark to wait on — so the hamburger it
  // carries is the landing signal. The legacy 레슨 기록 list is still
  // reachable via the drawer, just not the default.
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /open menu/i })).toBeInTheDocument();
  });
};

const openHamburger = () =>
  fireEvent.click(screen.getByRole('button', { name: /open menu/i }));

describe('Coach app shell (post-redesign)', () => {
  beforeEach(() => {
    // 이 테스트는 기존 전체 기능 화면을 본다(기본은 녹음·정리·전달 단순 화면).
    localStorage.setItem('coachxai_coach_ui_mode', 'full');
    vi.clearAllMocks();
  });

  it('lands on the agent home with no tab bar and the hamburger present', async () => {
    await renderCoachApp();

    // Single-surface relaunch: the agent conversation is the app — no
    // bottom navigation exists any more.
    expect(screen.queryByRole('navigation', { name: /coach navigation/i })).toBeNull();

    // Hamburger button in the agent home's own header.
    expect(screen.getByRole('button', { name: /open menu/i })).toBeInTheDocument();

    // The agent's opening proposal — the core action offered up front.
    expect(screen.getByText(/레슨 동반을 시작하시겠습니까/)).toBeInTheDocument();
  });

  it('does not render the legacy dashboard quick-action buttons', async () => {
    await renderCoachApp();

    expect(screen.queryByTestId('start-lesson-btn')).toBeNull();
    expect(screen.queryByTestId('coachx-entry-btn')).toBeNull();
    expect(screen.queryByTestId('students-entry-btn')).toBeNull();
    expect(screen.queryByTestId('reservations-entry-btn')).toBeNull();
    expect(screen.queryByTestId('lesson-upload-entry-btn')).toBeNull();
    expect(screen.queryByTestId('diagnosis-program-entry-btn')).toBeNull();
  });

  it('opens the diagnosis program from the hamburger menu', async () => {
    await renderCoachApp();
    openHamburger();

    fireEvent.click(screen.getByRole('button', { name: /정밀진단/i }));

    await waitFor(() => {
      expect(screen.getByTestId('diagnosis-program-section')).toBeInTheDocument();
    });
    expect(screen.getAllByText('골퍼 기본정보 입력').length).toBeGreaterThan(0);
    expect(screen.getByText('프로세스 1 / 7')).toBeInTheDocument();
    expect(screen.getByTestId('diagnosis-view-result-btn')).toBeInTheDocument();
  });

  it('completes the diagnosis flow and returns to the intro screen', async () => {
    const expectedOverallScore = Math.round((90 + 85 + 80) / 3);

    await renderCoachApp();
    openHamburger();
    fireEvent.click(screen.getByRole('button', { name: /정밀진단/i }));

    await waitFor(() => {
      expect(screen.getByTestId('diagnosis-program-section')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('diagnosis-member-name-input'), {
      target: { value: '홍길동' },
    });
    fireEvent.change(screen.getByTestId('diagnosis-golfer-gender-select'), {
      target: { value: 'male' },
    });
    fireEvent.change(screen.getByTestId('diagnosis-golfer-age-input'), {
      target: { value: '36' },
    });
    fireEvent.change(screen.getByTestId('diagnosis-golfer-height-input'), {
      target: { value: '178' },
    });
    fireEvent.change(screen.getByTestId('diagnosis-golfer-years-of-experience-input'), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByTestId('diagnosis-golfer-average-score-input'), {
      target: { value: '92' },
    });
    fireEvent.change(screen.getByTestId('diagnosis-golfer-dominant-hand-select'), {
      target: { value: 'right' },
    });
    fireEvent.click(screen.getByTestId('diagnosis-golfer-goal-score-improvement'));
    fireEvent.click(screen.getByTestId('diagnosis-next-step-btn'));
    fireEvent.change(screen.getByTestId('diagnosis-score-input-body'), {
      target: { value: '90' },
    });

    fireEvent.click(screen.getByTestId('diagnosis-next-step-btn'));
    fireEvent.change(screen.getByTestId('diagnosis-score-input-equipment'), {
      target: { value: '85' },
    });
    fireEvent.click(screen.getByTestId('diagnosis-next-step-btn'));
    fireEvent.change(screen.getByTestId('diagnosis-score-input-skill'), {
      target: { value: '80' },
    });
    // 숏게임 퍼포먼스 테스트 — optional, skip without input.
    fireEvent.click(screen.getByTestId('diagnosis-next-step-btn'));
    fireEvent.click(screen.getByTestId('diagnosis-next-step-btn'));
    fireEvent.change(screen.getByTestId('diagnosis-course-note-input'), {
      target: { value: '공략 루트 선택이 보수적' },
    });
    fireEvent.change(screen.getByTestId('diagnosis-mental-note-input'), {
      target: { value: '멘탈 루틴 안정적' },
    });
    fireEvent.click(screen.getByTestId('diagnosis-next-step-btn'));

    fireEvent.click(screen.getByTestId('diagnosis-view-result-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('diagnosis-result-section')).toBeInTheDocument();
    });
    expect(screen.getByText('정밀진단 결과')).toBeInTheDocument();
    expect(screen.getByText(/홍길동.*진단 요약/)).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.textContent?.replace(/\s+/g, ' ').trim() === `점수 ${expectedOverallScore}`)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('diagnosis-back-to-program-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('diagnosis-program-section')).toBeInTheDocument();
    });
  });

  it('allows advancing past the golfer inputs step without full completion', async () => {
    await renderCoachApp();
    openHamburger();
    fireEvent.click(screen.getByRole('button', { name: /정밀진단/i }));

    await waitFor(() => {
      expect(screen.getByTestId('diagnosis-program-section')).toBeInTheDocument();
    });

    const nextButton = screen.getByTestId('diagnosis-next-step-btn');
    expect(nextButton).not.toBeDisabled();
    expect(screen.getByTestId('diagnosis-golfer-required-hint')).toBeInTheDocument();

    fireEvent.click(nextButton);

    expect(screen.getByText('신체 체형 진단')).toBeInTheDocument();
  });

  // The redesign removes the raised "+ 기록" button from the bottom nav —
  // new records now originate from the agent conversation instead of a fixed
  // CTA. The direct-registration entry point still exists on the
  // LessonStartPromptModal; its coverage lives with that component's own
  // tests rather than here.
});

describe('Coach app shell — 기본 단순 화면', () => {
  beforeEach(() => {
    localStorage.removeItem('coachxai_coach_ui_mode');
    vi.clearAllMocks();
  });

  it('코치는 기본으로 녹음·정리·전달 단순 화면에 들어온다', async () => {
    render(<App />);
    expect(await screen.findByRole('button', { name: /레슨 녹음 시작/ })).toBeInTheDocument();
    // 예전 전체 화면의 메뉴는 보이지 않는다.
    expect(screen.queryByRole('button', { name: /open menu/i })).toBeNull();
  });

  it('전체 기능 화면을 고르면 기기에 남고, 메뉴에서 단순 화면으로 돌아올 수 있다', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '설정' }));
    fireEvent.click(screen.getByRole('button', { name: '전체 기능 화면으로' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /open menu/i })).toBeInTheDocument();
    });
    expect(localStorage.getItem('coachxai_coach_ui_mode')).toBe('full');

    openHamburger();
    fireEvent.click(screen.getByRole('button', { name: /단순 화면/ }));
    expect(await screen.findByRole('button', { name: /레슨 녹음 시작/ })).toBeInTheDocument();
    expect(localStorage.getItem('coachxai_coach_ui_mode')).toBe('simple');
  });
});
