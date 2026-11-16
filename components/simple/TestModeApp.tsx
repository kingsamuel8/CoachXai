import React, { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { LanguageProvider, useLanguage } from '../LanguageContext';
import { SimpleCoachApp, type SimpleCoachBackend } from './SimpleCoachApp';
import { listTestLessons, saveTestLesson } from '../../services/testLessonStore';
import { encodeNoteLink } from '../../utils/noteLink';
import {
  exitTestMode,
  getTestCoachName,
  getTestGeminiKey,
  setTestCoachName,
  setTestGeminiKey,
} from '../../utils/testMode';
import type { Lesson } from '../../types';

/**
 * 테스트 모드 앱(?test=1) — 서버 없이 녹음 → 정리 → 전달을 시험한다.
 * 로그인 대신 코치 이름과 테스트용 Gemini API 키를 한 번 받는다.
 */
const TEXT = {
  ko: {
    title: '테스트 모드',
    intro: '서버 없이 녹음 → 정리 → 전달을 시험해 보는 모드예요. 레슨은 이 기기에만 저장돼요.',
    coachName: '코치 이름',
    apiKey: 'Gemini API 키',
    apiKeyHelp: '받아 적기와 정리에 쓰여요. 키는 이 기기에만 저장되고 Google 외에는 보내지 않아요. Google AI Studio(aistudio.google.com)에서 만들 수 있어요.',
    start: '테스트 시작',
    banner: '테스트 모드 · 서버에 저장되지 않고 이 기기에만 남아요',
    settings: '테스트 설정',
    exit: '테스트 모드 끝내기',
    save: '저장',
    back: '돌아가기',
  },
  en: {
    title: 'Test mode',
    intro: 'Try record → organize → send without the server. Lessons stay on this device only.',
    coachName: 'Coach name',
    apiKey: 'Gemini API key',
    apiKeyHelp: 'Used for transcription and notes. It stays on this device and is only sent to Google. Create one at Google AI Studio (aistudio.google.com).',
    start: 'Start testing',
    banner: 'Test mode · nothing is saved to the server; lessons stay on this device',
    settings: 'Test settings',
    exit: 'Exit test mode',
    save: 'Save',
    back: 'Back',
  },
};

/** 이 기기에 저장 + 노트를 링크에 담아 보낸다. */
export const testBackend = (coachName: () => string): SimpleCoachBackend => ({
  saveLesson: async (lesson) => saveTestLesson(lesson),
  shareLink: async (lesson: Lesson, note) =>
    encodeNoteLink({
      coachName: coachName(),
      studentName: lesson.clientName,
      date: lesson.date,
      note,
    }),
});

const TestModeInner: React.FC = () => {
  const { language } = useLanguage();
  const T = language === 'ko' ? TEXT.ko : TEXT.en;
  const [coachName, setCoachName] = useState(getTestCoachName);
  const [apiKey, setApiKey] = useState(getTestGeminiKey);
  const [configured, setConfigured] = useState(() => !!getTestCoachName() && !!getTestGeminiKey());
  const [lessons, setLessons] = useState<Lesson[]>(listTestLessons);

  if (!configured) {
    const ready = coachName.trim() && apiKey.trim();
    return (
      <div className="min-h-screen bg-base text-ink-high flex flex-col pt-safe pb-safe">
        <main className="flex-1 px-5 py-8 flex flex-col gap-5 max-w-md w-full mx-auto">
          <div className="flex items-center gap-2 text-amber-300">
            <FlaskConical className="w-5 h-5" />
            <h1 className="text-[20px] font-bold">{T.title}</h1>
          </div>
          <p className="text-[14px] text-ink-medium">{T.intro}</p>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-bold">{T.coachName}</span>
            <input
              value={coachName}
              onChange={(e) => setCoachName(e.target.value)}
              className="h-12 rounded-xl border border-line-subtle bg-white/[0.04] px-4 text-[15px] outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="test-gemini-key" className="text-[12px] font-bold">
              {T.apiKey}
            </label>
            <input
              id="test-gemini-key"
              type="password"
              autoComplete="off"
              aria-describedby="test-gemini-key-help"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="h-12 rounded-xl border border-line-subtle bg-white/[0.04] px-4 text-[15px] outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <p id="test-gemini-key-help" className="text-[11.5px] text-ink-muted">
              {T.apiKeyHelp}
            </p>
          </div>
          <button
            type="button"
            disabled={!ready}
            onClick={() => {
              setTestCoachName(coachName);
              setTestGeminiKey(apiKey);
              setConfigured(true);
            }}
            className="h-14 rounded-2xl bg-emerald-500 text-black font-bold text-[16px] disabled:opacity-40"
          >
            {T.start}
          </button>
          {getTestCoachName() && getTestGeminiKey() && (
            <button
              type="button"
              onClick={() => setConfigured(true)}
              className="h-11 text-[14px] text-ink-medium"
            >
              {T.back}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              exitTestMode();
              window.location.replace(window.location.pathname);
            }}
            className="h-11 text-[13px] text-ink-muted"
          >
            {T.exit}
          </button>
        </main>
      </div>
    );
  }

  return (
    <SimpleCoachApp
      coach={{ id: 'test-coach', name: getTestCoachName() || coachName }}
      students={[]}
      lessons={lessons}
      onLessonSaved={() => setLessons(listTestLessons())}
      onLogout={() => setConfigured(false)}
      logoutLabel={T.settings}
      banner={T.banner}
      backend={testBackend(() => getTestCoachName() || coachName)}
    />
  );
};

export const TestModeApp: React.FC = () => (
  <LanguageProvider>
    <TestModeInner />
  </LanguageProvider>
);
