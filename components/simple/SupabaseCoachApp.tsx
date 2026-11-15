import React, { useCallback, useEffect, useState } from 'react';
import { LanguageProvider, useLanguage } from '../LanguageContext';
import { SimpleCoachApp, type SimpleCoachBackend } from './SimpleCoachApp';
import { getSupabase } from '../../services/supabaseClient';
import {
  listMyClients,
  listMyLessons,
  loadCurrentCoach,
  saveMyLesson,
  shareMyLesson,
  type SupabaseCoach,
} from '../../services/supabaseCoachStore';
import { lessonNoteUrl } from '../../utils/publicAppUrl';
import { exitSupabaseMode } from '../../utils/supabaseMode';
import type { ClientProfile, Lesson } from '../../types';

/**
 * Supabase 모드 코치 앱(?supabase=1) — Express 서버 없이 녹음 → 정리 → 전달.
 * 로그인은 Supabase Auth, 저장·공유는 Supabase 표와 함수, AI 는 Edge Function.
 */
const TEXT = {
  ko: {
    title: 'CoachX 코치',
    login: '로그인',
    signup: '가입하기',
    toSignup: '처음이세요? 가입하기',
    toLogin: '이미 계정이 있어요 · 로그인',
    name: '이름',
    email: '이메일',
    password: '비밀번호 (6자 이상)',
    working: '잠시만요…',
    checkEmail: '가입 확인 메일을 보냈어요. 메일의 링크를 누른 뒤 로그인해 주세요.',
    notCoach: '이 계정은 코치 계정이 아니에요. 코치로 가입한 계정으로 로그인해 주세요.',
    loadFailed: '기록을 불러오지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.',
    retry: '다시 시도',
    logout: '로그아웃',
    exitMode: '예전 서버 화면으로',
    failed: '로그인하지 못했어요. 이메일과 비밀번호를 확인해 주세요.',
    signupFailed: '가입하지 못했어요.',
  },
  en: {
    title: 'CoachX Coach',
    login: 'Log in',
    signup: 'Sign up',
    toSignup: 'New here? Sign up',
    toLogin: 'Already have an account? Log in',
    name: 'Name',
    email: 'Email',
    password: 'Password (6+ characters)',
    working: 'One moment…',
    checkEmail: 'We sent a confirmation email. Open the link in it, then log in.',
    notCoach: 'This account is not a coach account. Log in with the account you signed up with as a coach.',
    loadFailed: 'Couldn’t load your records. Check your connection and try again.',
    retry: 'Try again',
    logout: 'Log out',
    exitMode: 'Back to the classic server app',
    failed: 'Couldn’t log in. Check your email and password.',
    signupFailed: 'Couldn’t sign up.',
  },
};

/** Supabase 에 저장 + 공유 토큰 링크(?note=<토큰>, 고객은 로그인 없이 연다). */
export const supabaseBackend = (coachId: string): SimpleCoachBackend => ({
  saveLesson: (lesson: Lesson) => saveMyLesson(lesson, coachId),
  shareLink: async (lesson: Lesson) => lessonNoteUrl(await shareMyLesson(lesson.id)),
});

type Phase =
  | { kind: 'checking' }
  | { kind: 'signedOut' }
  | { kind: 'notCoach' }
  | { kind: 'loadFailed' }
  | { kind: 'ready'; coach: SupabaseCoach; students: ClientProfile[]; lessons: Lesson[] };

const field =
  'h-12 rounded-xl border border-line-subtle bg-white/[0.04] px-4 text-[15px] outline-none focus:ring-2 focus:ring-emerald-500';

const SupabaseCoachInner: React.FC = () => {
  const { language } = useLanguage();
  const T = language === 'ko' ? TEXT.ko : TEXT.en;
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase({ kind: 'checking' });
    try {
      const { data } = await getSupabase().auth.getSession();
      if (!data.session) {
        setPhase({ kind: 'signedOut' });
        return;
      }
      const coach = await loadCurrentCoach();
      if (!coach) {
        setPhase({ kind: 'notCoach' });
        return;
      }
      const [students, lessons] = await Promise.all([listMyClients(), listMyLessons()]);
      setPhase({ kind: 'ready', coach, students, lessons });
    } catch {
      setPhase({ kind: 'loadFailed' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const logout = async () => {
    await getSupabase().auth.signOut();
    setPassword('');
    setPhase({ kind: 'signedOut' });
  };

  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const sb = getSupabase();
      if (mode === 'signup') {
        const { data, error } = await sb.auth.signUp({
          email: email.trim(),
          password,
          // DB 가입 트리거(handle_new_coach)가 이 값으로 코치 행을 만든다.
          options: { data: { role: 'coach', name: name.trim() } },
        });
        if (error) {
          setMessage(`${T.signupFailed} ${error.message}`);
          return;
        }
        if (!data.session) {
          setMessage(T.checkEmail);
          setMode('login');
          return;
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
        if (error) {
          setMessage(T.failed);
          return;
        }
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (phase.kind === 'ready') {
    return (
      <SimpleCoachApp
        coach={{ id: phase.coach.id, name: phase.coach.name }}
        students={phase.students}
        lessons={phase.lessons}
        onLessonSaved={(saved) =>
          setPhase((p) =>
            p.kind === 'ready'
              ? { ...p, lessons: [saved, ...p.lessons.filter((l) => l.id !== saved.id)] }
              : p
          )
        }
        onLogout={() => void logout()}
        logoutLabel={T.logout}
        backend={supabaseBackend(phase.coach.id)}
      />
    );
  }

  const ready =
    email.trim() && password.length >= 6 && (mode === 'login' || name.trim().length > 0);

  return (
    <div className="min-h-screen bg-base text-ink-high flex flex-col pt-safe pb-safe">
      <main className="flex-1 px-5 py-8 flex flex-col gap-4 max-w-md w-full mx-auto">
        <h1 className="text-[22px] font-bold">{T.title}</h1>

        {phase.kind === 'checking' && (
          <p role="status" className="text-[14px] text-ink-medium">{T.working}</p>
        )}

        {(phase.kind === 'notCoach' || phase.kind === 'loadFailed') && (
          <>
            <p role="alert" className="text-[14px] text-ink-medium">
              {phase.kind === 'notCoach' ? T.notCoach : T.loadFailed}
            </p>
            {phase.kind === 'loadFailed' && (
              <button type="button" onClick={() => void load()} className="h-12 rounded-2xl bg-emerald-500 text-black font-bold">
                {T.retry}
              </button>
            )}
            <button type="button" onClick={() => void logout()} className="h-11 text-[14px] text-ink-medium">
              {T.logout}
            </button>
          </>
        )}

        {phase.kind === 'signedOut' && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready && !busy) void submit();
            }}
          >
            {mode === 'signup' && (
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-bold">{T.name}</span>
                <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className={field} />
              </label>
            )}
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-bold">{T.email}</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-bold">{T.password}</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                className={field}
              />
            </label>
            {message && (
              <p role="alert" className="text-[13px] text-amber-300">{message}</p>
            )}
            <button
              type="submit"
              disabled={!ready || busy}
              className="h-14 rounded-2xl bg-emerald-500 text-black font-bold text-[16px] disabled:opacity-40"
            >
              {busy ? T.working : mode === 'signup' ? T.signup : T.login}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'login' ? 'signup' : 'login');
                setMessage(null);
              }}
              className="h-11 text-[14px] text-ink-medium"
            >
              {mode === 'login' ? T.toSignup : T.toLogin}
            </button>
          </form>
        )}

        <button
          type="button"
          onClick={() => {
            exitSupabaseMode();
            window.location.replace(window.location.pathname);
          }}
          className="mt-auto h-11 text-[13px] text-ink-muted"
        >
          {T.exitMode}
        </button>
      </main>
    </div>
  );
};

export const SupabaseCoachApp: React.FC = () => (
  <LanguageProvider>
    <SupabaseCoachInner />
  </LanguageProvider>
);
