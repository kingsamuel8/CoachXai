import React, { useMemo, useState } from 'react';
import { Check, ChevronLeft, Copy, LogOut, Mic, RefreshCw, Send, Settings } from 'lucide-react';
import { LiveLessonCompanion } from '../LiveLessonCompanion';
import { useLanguage, type Language } from '../LanguageContext';
import { apiService } from '../../services/apiService';
import { parseReviewedTranscript, type LiveLessonHandoff } from '../../services/lessonAudioPipeline';
import {
  NOTE_LABELS,
  NOTE_LANGUAGES,
  emptyClientNote,
  formatClientNoteMessage,
  generateClientNote,
  isNoteLanguage,
  type NoteLanguage,
} from '../../services/lessonClientNote';
import { lessonNoteUrl } from '../../utils/publicAppUrl';
import type { ClientProfile, Lesson, LessonClientNote } from '../../types';

/**
 * 단순 코치 화면 — 녹음 → 정리 → 전달, 세 단계만 있다.
 *
 *  1. 녹음: 고객 이름을 고르고 레슨을 녹음한다(LiveLessonCompanion 을 그대로 쓴다 —
 *     받아 적기·정밀 전사·골프 용어 교정·검토가 모두 그 안에 있다).
 *  2. 정리: 필기로 **고객용 레슨 노트**(오늘의 핵심·연습 과제·다음 레슨)를 고객
 *     언어로 만들고, 코치가 고친다.
 *  3. 전달: 저장하면 앱 없이 열리는 링크가 생기고, 휴대폰 공유 창으로 카카오톡·
 *     WhatsApp·문자에 바로 보낸다.
 *
 * 예약·포인트·지점·진단 같은 기존 기능은 지우지 않았다. 설정의 "전체 기능"
 * 으로 예전 화면을 열 수 있다(onOpenFullApp).
 */

type UiText = {
  steps: [string, string, string];
  whoTitle: string;
  namePlaceholder: string;
  start: string;
  recent: string;
  noRecent: string;
  organizing: string;
  noteTitle: string;
  noteLanguage: string;
  regenerate: string;
  headline: string;
  keyPoints: string;
  drills: string;
  nextFocus: string;
  message: string;
  onePerLine: string;
  saveAndSend: string;
  saving: string;
  sentTitle: string;
  sentBody: string;
  shareAgain: string;
  copiedForPaste: string;
  copyLink: string;
  copied: string;
  newLesson: string;
  back: string;
  settings: string;
  appLanguage: string;
  fullApp: string;
  logout: string;
  noRecording: string;
  noteFailed: string;
  saveFailed: string;
  emptyNote: string;
};

const TEXT: Record<'ko' | 'en', UiText> = {
  ko: {
    steps: ['녹음', '정리', '전달'],
    whoTitle: '누구의 레슨인가요?',
    namePlaceholder: '고객 이름',
    start: '레슨 녹음 시작',
    recent: '보낸 레슨 노트',
    noRecent: '아직 보낸 노트가 없어요. 첫 레슨을 녹음해 보세요.',
    organizing: '레슨 핵심을 정리하고 있어요…',
    noteTitle: '고객에게 보낼 레슨 노트',
    noteLanguage: '노트 언어',
    regenerate: '이 언어로 다시 정리',
    headline: '한 줄 요약',
    keyPoints: '오늘의 핵심',
    drills: '연습 과제',
    nextFocus: '다음 레슨',
    message: '코치 한마디',
    onePerLine: '한 줄에 하나씩',
    saveAndSend: '저장하고 보내기',
    saving: '저장하는 중…',
    sentTitle: '레슨 노트가 준비됐어요',
    sentBody: '보내기를 누르면 카카오톡·문자 등으로 보낼 수 있어요. 고객은 앱 없이 링크로 바로 봐요.',
    shareAgain: '고객에게 보내기',
    copiedForPaste: '노트를 복사했어요. 메신저에 붙여 넣어 보내 주세요.',
    copyLink: '링크 복사',
    copied: '복사했어요',
    newLesson: '새 레슨 녹음',
    back: '뒤로',
    settings: '설정',
    appLanguage: '앱 언어',
    fullApp: '전체 기능 화면으로',
    logout: '로그아웃',
    noRecording: '녹음된 내용이 없어 노트를 만들 수 없어요.',
    noteFailed: '자동 정리에 실패했어요. 직접 적어서 보낼 수 있어요.',
    saveFailed: '저장하지 못했어요. 네트워크를 확인하고 다시 시도해 주세요.',
    emptyNote: '보낼 내용이 없어요. 한 줄 요약이나 핵심을 적어 주세요.',
  },
  en: {
    steps: ['Record', 'Organize', 'Send'],
    whoTitle: 'Who is this lesson for?',
    namePlaceholder: 'Student name',
    start: 'Start recording',
    recent: 'Sent lesson notes',
    noRecent: 'No notes sent yet. Record your first lesson.',
    organizing: 'Pulling out the key points…',
    noteTitle: 'Lesson notes for your student',
    noteLanguage: 'Note language',
    regenerate: 'Rewrite in this language',
    headline: 'Summary',
    keyPoints: 'Key points',
    drills: 'Practice',
    nextFocus: 'Next lesson',
    message: 'Message from coach',
    onePerLine: 'One per line',
    saveAndSend: 'Save and send',
    saving: 'Saving…',
    sentTitle: 'Your lesson notes are ready',
    sentBody: 'Tap send to share via WhatsApp, Messages and more. Your student opens the link without the app.',
    shareAgain: 'Send to student',
    copiedForPaste: 'Notes copied. Paste them into your messaging app to send.',
    copyLink: 'Copy link',
    copied: 'Copied',
    newLesson: 'Record a new lesson',
    back: 'Back',
    settings: 'Settings',
    appLanguage: 'App language',
    fullApp: 'Open full app',
    logout: 'Log out',
    noRecording: 'Nothing was recorded, so there is nothing to summarize.',
    noteFailed: 'Automatic summary failed. You can write the notes yourself.',
    saveFailed: 'Could not save. Check your connection and try again.',
    emptyNote: 'The notes are empty. Add a summary or a key point.',
  },
};

const uiText = (lang: Language): UiText => (lang === 'ko' ? TEXT.ko : TEXT.en);

const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const linesOf = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.replace(/^\s*[-•*\d.)]+\s*/, '').trim())
    .filter(Boolean);

interface Recipient {
  name: string;
  phone: string;
}

export interface SimpleCoachAppProps {
  coach: { id: string; name: string };
  /** 이 코치의 회원 목록 — 고르면 회원 앱과도 기록이 이어진다. */
  students: ClientProfile[];
  /** 이 코치의 레슨 기록 — 최근 보낸 노트 목록에 쓴다. */
  lessons: Lesson[];
  onLessonSaved: (lesson: Lesson) => void;
  onOpenFullApp: () => void;
  onLogout: () => void;
}

type Stage =
  | { kind: 'home' }
  | { kind: 'record'; recipient: Recipient }
  | { kind: 'note'; recipient: Recipient; handoff: LiveLessonHandoff }
  | { kind: 'sent'; lesson: Lesson; note: LessonClientNote; url: string };

export const SimpleCoachApp: React.FC<SimpleCoachAppProps> = ({
  coach,
  students,
  lessons,
  onLessonSaved,
  onOpenFullApp,
  onLogout,
}) => {
  const { language, setLanguage } = useLanguage();
  const T = uiText(language);
  const [stage, setStage] = useState<Stage>({ kind: 'home' });
  const [notice, setNotice] = useState<string | null>(null);

  if (stage.kind === 'record') {
    return (
      <LiveLessonCompanion
        studentName={stage.recipient.name}
        lessonDate={today()}
        onCancel={() => setStage({ kind: 'home' })}
        onFinish={(_clips, handoff) => {
          if (!handoff) {
            setNotice(T.noRecording);
            setStage({ kind: 'home' });
            return;
          }
          setStage({ kind: 'note', recipient: stage.recipient, handoff });
        }}
      />
    );
  }

  if (stage.kind === 'note') {
    return (
      <NoteStep
        T={T}
        coach={coach}
        recipient={stage.recipient}
        handoff={stage.handoff}
        defaultLanguage={isNoteLanguage(language) ? language : 'en'}
        onBack={() => setStage({ kind: 'home' })}
        onSent={(lesson, note, url) => {
          onLessonSaved(lesson);
          setStage({ kind: 'sent', lesson, note, url });
        }}
      />
    );
  }

  if (stage.kind === 'sent') {
    return (
      <SentStep
        T={T}
        coachName={coach.name}
        lesson={stage.lesson}
        note={stage.note}
        url={stage.url}
        onDone={() => setStage({ kind: 'home' })}
      />
    );
  }

  return (
    <HomeStep
      T={T}
      coach={coach}
      students={students}
      lessons={lessons}
      notice={notice}
      language={language}
      onLanguageChange={setLanguage}
      onStart={(recipient) => {
        setNotice(null);
        setStage({ kind: 'record', recipient });
      }}
      onOpenSent={(lesson, note, url) => setStage({ kind: 'sent', lesson, note, url })}
      onOpenFullApp={onOpenFullApp}
      onLogout={onLogout}
    />
  );
};

// ─── 단계 표시 ──────────────────────────────────────────────────────────────

const StepBar: React.FC<{ steps: [string, string, string]; active: 0 | 1 | 2 }> = ({
  steps,
  active,
}) => (
  <ol className="flex items-center gap-2 text-[12px]" aria-label="steps">
    {steps.map((label, i) => (
      <li
        key={label}
        aria-current={i === active ? 'step' : undefined}
        className={`flex items-center gap-1.5 ${i === active ? 'text-emerald-300 font-bold' : 'text-ink-muted'}`}
      >
        <span
          className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] ${
            i < active
              ? 'bg-emerald-500 text-black'
              : i === active
                ? 'bg-emerald-500/20 text-emerald-300'
                : 'bg-white/10'
          }`}
        >
          {i < active ? <Check className="w-3 h-3" /> : i + 1}
        </span>
        {label}
        {i < 2 && <span className="text-ink-muted mx-1">›</span>}
      </li>
    ))}
  </ol>
);

// ─── 1. 홈: 고객 고르고 녹음 시작 ────────────────────────────────────────────

const HomeStep: React.FC<{
  T: UiText;
  coach: { id: string; name: string };
  students: ClientProfile[];
  lessons: Lesson[];
  notice: string | null;
  language: Language;
  onLanguageChange: (l: Language) => void;
  onStart: (r: Recipient) => void;
  onOpenSent: (lesson: Lesson, note: LessonClientNote, url: string) => void;
  onOpenFullApp: () => void;
  onLogout: () => void;
}> = ({
  T,
  coach,
  students,
  lessons,
  notice,
  language,
  onLanguageChange,
  onStart,
  onOpenSent,
  onOpenFullApp,
  onLogout,
}) => {
  const [name, setName] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  // 회원 + 최근 레슨의 고객을 한 목록으로(이름 기준, 회원 쪽 전화번호 우선).
  const known = useMemo(() => {
    const map = new Map<string, Recipient>();
    for (const s of students) if (s.name) map.set(s.name, { name: s.name, phone: s.phone ?? '' });
    for (const l of lessons) {
      if (l.clientName && !map.has(l.clientName)) {
        map.set(l.clientName, { name: l.clientName, phone: l.clientPhone ?? '' });
      }
    }
    return [...map.values()];
  }, [students, lessons]);

  const recentNotes = useMemo(
    () =>
      lessons
        .filter((l) => l.liveLessonDetail?.clientNote)
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        .slice(0, 20),
    [lessons]
  );

  const recentNames = known.slice(0, 8);
  const trimmed = name.trim();
  const recipientFor = (n: string): Recipient =>
    known.find((k) => k.name === n) ?? { name: n, phone: '' };

  const openSent = async (lesson: Lesson) => {
    if (!lesson.id || !lesson.liveLessonDetail?.clientNote) return;
    setOpening(lesson.id);
    try {
      const { token } = await apiService.shareLesson(lesson.id);
      onOpenSent(lesson, lesson.liveLessonDetail.clientNote, lessonNoteUrl(token));
    } catch {
      // 링크를 못 만들면 목록에 그대로 둔다 — 다시 누르면 된다.
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="min-h-screen bg-base text-ink-high flex flex-col pt-safe pb-safe">
      <header className="px-5 py-4 flex items-center gap-3 border-b border-line-subtle">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-mono uppercase tracking-wider text-emerald-300">CoachX</div>
          <div className="text-[15px] font-bold truncate">{coach.name}</div>
        </div>
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          aria-label={T.settings}
          aria-expanded={settingsOpen}
          className="w-11 h-11 -mr-2 flex items-center justify-center text-ink-muted hover:text-ink-high"
        >
          <Settings className="w-5 h-5" />
        </button>
      </header>

      {settingsOpen && (
        <div className="px-5 py-3 border-b border-line-subtle flex flex-col gap-3 bg-white/[0.03]">
          <label className="flex items-center justify-between gap-3 text-[13px]">
            <span>{T.appLanguage}</span>
            <select
              value={language}
              onChange={(e) => onLanguageChange(e.target.value as Language)}
              className="rounded-lg border border-line-subtle bg-base px-2 py-1.5 text-[13px]"
            >
              {(Object.keys(NOTE_LANGUAGES) as NoteLanguage[]).map((l) => (
                <option key={l} value={l}>
                  {NOTE_LANGUAGES[l]}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onOpenFullApp}
              className="flex-1 h-10 rounded-lg border border-line-subtle text-[13px]"
            >
              {T.fullApp}
            </button>
            <button
              type="button"
              onClick={onLogout}
              className="flex-1 h-10 rounded-lg border border-line-subtle text-[13px] flex items-center justify-center gap-1.5"
            >
              <LogOut className="w-4 h-4" />
              {T.logout}
            </button>
          </div>
        </div>
      )}

      <main className="flex-1 px-5 py-6 flex flex-col gap-8 max-w-xl w-full mx-auto">
        <StepBar steps={T.steps} active={0} />

        {notice && (
          <p role="alert" className="text-[13px] text-amber-300">
            {notice}
          </p>
        )}

        <section className="flex flex-col gap-3">
          <h1 className="text-[20px] font-bold">{T.whoTitle}</h1>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && trimmed) onStart(recipientFor(trimmed));
            }}
            list="simple-known-students"
            placeholder={T.namePlaceholder}
            aria-label={T.namePlaceholder}
            className="h-12 rounded-xl border border-line-subtle bg-white/[0.04] px-4 text-[16px] placeholder:text-ink-muted focus:ring-2 focus:ring-emerald-500 outline-none"
          />
          <datalist id="simple-known-students">
            {known.map((k) => (
              <option key={k.name} value={k.name} />
            ))}
          </datalist>
          {recentNames.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {recentNames.map((k) => (
                <button
                  key={k.name}
                  type="button"
                  onClick={() => setName(k.name)}
                  className={`h-9 px-3 rounded-full text-[13px] border ${
                    trimmed === k.name
                      ? 'border-emerald-400 bg-emerald-500/15 text-emerald-200'
                      : 'border-line-subtle text-ink-medium'
                  }`}
                >
                  {k.name}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            disabled={!trimmed}
            onClick={() => onStart(recipientFor(trimmed))}
            className="mt-2 h-14 rounded-2xl bg-emerald-500 text-black font-bold text-[16px] flex items-center justify-center gap-2 disabled:opacity-40"
          >
            <Mic className="w-5 h-5" />
            {T.start}
          </button>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-[13px] font-bold text-ink-medium">{T.recent}</h2>
          {recentNotes.length === 0 ? (
            <p className="text-[13px] text-ink-muted">{T.noRecent}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line-subtle rounded-xl border border-line-subtle">
              {recentNotes.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    onClick={() => void openSent(l)}
                    disabled={opening === l.id}
                    className="w-full text-left px-4 py-3 flex flex-col gap-0.5 disabled:opacity-50"
                  >
                    <span className="text-[13px] text-ink-muted">
                      {l.clientName} · {l.date}
                    </span>
                    <span className="text-[14px] truncate">
                      {l.liveLessonDetail?.clientNote?.headline || l.title}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
};

// ─── 2. 정리: 고객용 노트 만들고 고치기 ──────────────────────────────────────

const NoteStep: React.FC<{
  T: UiText;
  coach: { id: string; name: string };
  recipient: Recipient;
  handoff: LiveLessonHandoff;
  defaultLanguage: NoteLanguage;
  onBack: () => void;
  onSent: (lesson: Lesson, note: LessonClientNote, url: string) => void;
}> = ({ T, coach, recipient, handoff, defaultLanguage, onBack, onSent }) => {
  const [noteLanguage, setNoteLanguage] = useState<NoteLanguage>(defaultLanguage);
  const [draft, setDraft] = useState<{
    headline: string;
    keyPoints: string;
    drills: string;
    nextFocus: string;
    message: string;
  } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const transcript = handoff.editedTranscript ?? '';

  const generate = React.useCallback(
    async (lang: NoteLanguage) => {
      setGenerating(true);
      setError(null);
      try {
        const note =
          (await generateClientNote({
            studentName: recipient.name,
            coachName: coach.name,
            language: lang,
            transcript,
            coachSummary: handoff.editedCoachSummary,
          })) ?? null;
        if (!note) setError(T.noteFailed);
        const n = note ?? emptyClientNote(lang);
        setDraft({
          headline: n.headline,
          keyPoints: n.keyPoints.join('\n'),
          drills: n.drills.join('\n'),
          nextFocus: n.nextFocus,
          message: n.message,
        });
      } catch {
        setError(T.noteFailed);
        setDraft((d) => d ?? { headline: '', keyPoints: '', drills: '', nextFocus: '', message: '' });
      } finally {
        setGenerating(false);
      }
    },
    [T.noteFailed, coach.name, handoff.editedCoachSummary, recipient.name, transcript]
  );

  // 화면에 들어오자마자 한 번 정리한다.
  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void generate(noteLanguage);
  }, [generate, noteLanguage]);

  const handleSend = async () => {
    if (!draft) return;
    const note: LessonClientNote = {
      language: noteLanguage,
      headline: draft.headline.trim(),
      keyPoints: linesOf(draft.keyPoints),
      drills: linesOf(draft.drills),
      nextFocus: draft.nextFocus.trim(),
      message: draft.message.trim(),
    };
    if (!note.headline && note.keyPoints.length === 0) {
      setError(T.emptyNote);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const reviewed = transcript.trim() ? parseReviewedTranscript(transcript) : [];
      const lesson: Lesson = {
        id: '',
        clientName: recipient.name,
        clientPhone: recipient.phone,
        coachId: coach.id,
        createdBy: 'COACH',
        recordType: 'LIVE_LESSON',
        date: today(),
        title: note.headline || `${recipient.name} ${T.steps[0]}`,
        videoUrl: '',
        mediaType: 'audio',
        coachNotes: '',
        aiAnalysis: handoff.editedSummary || formatClientNoteMessage(note, {
          coachName: coach.name,
          studentName: recipient.name,
          date: today(),
        }),
        tags: [],
        createdAt: Date.now(),
        liveLessonDetail: {
          startedAt: handoff.startedAt,
          recordedDurationSec: handoff.recordedDurationSec,
          transcript: reviewed,
          summary: handoff.editedSummary,
          coachSummary: handoff.editedCoachSummary,
          studentSummary: handoff.editedStudentSummary,
          keyPoints: note.keyPoints,
          drills: note.drills,
          clientNote: note,
        },
      };
      const saved = await apiService.saveLesson(lesson);
      const { token } = await apiService.shareLesson(saved.id);
      const url = lessonNoteUrl(token);
      // 회원 앱을 쓰는 고객에게는 푸시도 간다(실패해도 링크 전달은 그대로).
      void import('../../services/notificationPreferenceService')
        .then(({ notifyLessonUploaded }) => notifyLessonUploaded(saved.id))
        .catch(() => {});
      onSent(saved, note, url);
    } catch {
      setError(T.saveFailed);
      setSaving(false);
    }
  };

  const L = NOTE_LABELS[noteLanguage];
  const field =
    'w-full rounded-xl border border-line-subtle bg-white/[0.04] p-3 text-[14px] leading-relaxed placeholder:text-ink-muted focus:ring-2 focus:ring-emerald-500 outline-none';

  return (
    <div className="min-h-screen bg-base text-ink-high flex flex-col pt-safe pb-safe">
      <header className="px-3 py-3 flex items-center gap-2 border-b border-line-subtle">
        <button
          type="button"
          onClick={onBack}
          aria-label={T.back}
          className="w-11 h-11 flex items-center justify-center text-ink-muted"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold truncate">{T.noteTitle}</div>
          <div className="text-[12px] text-ink-muted truncate">
            {recipient.name} · {today()}
          </div>
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto px-5 py-5 flex flex-col gap-5 max-w-xl w-full mx-auto">
        <StepBar steps={T.steps} active={1} />

        <div className="flex items-center gap-2">
          <label htmlFor="note-language" className="text-[12px] text-ink-muted">
            {T.noteLanguage}
          </label>
          <select
            id="note-language"
            value={noteLanguage}
            onChange={(e) => setNoteLanguage(e.target.value as NoteLanguage)}
            disabled={generating}
            className="rounded-lg border border-line-subtle bg-base px-2 py-1.5 text-[13px]"
          >
            {(Object.keys(NOTE_LANGUAGES) as NoteLanguage[]).map((l) => (
              <option key={l} value={l}>
                {NOTE_LANGUAGES[l]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void generate(noteLanguage)}
            disabled={generating}
            className="ml-auto h-9 px-3 rounded-lg border border-line-subtle text-[12px] flex items-center gap-1.5 disabled:opacity-40"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${generating ? 'animate-spin' : ''}`} />
            {T.regenerate}
          </button>
        </div>

        {error && (
          <p role="alert" className="text-[13px] text-amber-300">
            {error}
          </p>
        )}

        {!draft || generating ? (
          <p role="status" className="py-16 text-center text-[14px] text-ink-muted">
            {T.organizing}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-bold">{T.headline}</span>
              <input
                value={draft.headline}
                onChange={(e) => setDraft({ ...draft, headline: e.target.value })}
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-bold">
                {L.keyPoints} <span className="text-ink-muted font-normal">· {T.onePerLine}</span>
              </span>
              <textarea
                value={draft.keyPoints}
                onChange={(e) => setDraft({ ...draft, keyPoints: e.target.value })}
                rows={5}
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-bold">
                {L.drills} <span className="text-ink-muted font-normal">· {T.onePerLine}</span>
              </span>
              <textarea
                value={draft.drills}
                onChange={(e) => setDraft({ ...draft, drills: e.target.value })}
                rows={3}
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-bold">{L.nextFocus}</span>
              <input
                value={draft.nextFocus}
                onChange={(e) => setDraft({ ...draft, nextFocus: e.target.value })}
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-bold">{T.message}</span>
              <input
                value={draft.message}
                onChange={(e) => setDraft({ ...draft, message: e.target.value })}
                className={field}
              />
            </label>
          </div>
        )}
      </main>

      <footer className="px-5 py-3 border-t border-line-subtle">
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={!draft || generating || saving}
          className="w-full h-14 rounded-2xl bg-emerald-500 text-black font-bold text-[16px] flex items-center justify-center gap-2 disabled:opacity-40"
        >
          <Send className="w-5 h-5" />
          {saving ? T.saving : T.saveAndSend}
        </button>
      </footer>
    </div>
  );
};

// ─── 3. 전달 ────────────────────────────────────────────────────────────────

/**
 * 휴대폰 공유 창(카카오톡·WhatsApp·문자 등)으로 노트를 보낸다. 공유 창이 없는
 * 브라우저(데스크톱 등)에서는 클립보드에 복사한다.
 */
const shareNote = async (
  note: LessonClientNote,
  ctx: { coachName: string; studentName: string; date: string; url: string }
): Promise<'shared' | 'copied' | 'failed'> => {
  const text = formatClientNoteMessage(note, ctx);
  const lang = isNoteLanguage(note.language) ? note.language : 'en';
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      await navigator.share({ title: NOTE_LABELS[lang].title, text });
      return 'shared';
    }
  } catch (err) {
    // 코치가 공유 창을 닫은 것은 실패가 아니다.
    if ((err as { name?: string })?.name === 'AbortError') return 'failed';
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
};

const SentStep: React.FC<{
  T: UiText;
  coachName: string;
  lesson: Lesson;
  note: LessonClientNote;
  url: string;
  onDone: () => void;
}> = ({ T, coachName, lesson, note, url, onDone }) => {
  const [copied, setCopied] = useState(false);
  const [shareResult, setShareResult] = useState<'shared' | 'copied' | 'failed' | null>(null);
  const ctx = { coachName, studentName: lesson.clientName, date: lesson.date || today(), url };
  const L = NOTE_LABELS[isNoteLanguage(note.language) ? note.language : 'en'];

  return (
    <div className="min-h-screen bg-base text-ink-high flex flex-col pt-safe pb-safe">
      <main className="flex-1 px-5 py-8 flex flex-col gap-6 max-w-xl w-full mx-auto">
        <StepBar steps={T.steps} active={2} />
        <div className="flex flex-col items-center text-center gap-2 pt-4">
          <div className="w-14 h-14 rounded-full bg-emerald-500/15 text-emerald-300 flex items-center justify-center">
            <Check className="w-7 h-7" />
          </div>
          <h1 className="text-[20px] font-bold">{T.sentTitle}</h1>
          <p className="text-[13px] text-ink-muted">{T.sentBody}</p>
        </div>

        <div className="rounded-2xl border border-line-subtle bg-white/[0.04] p-4 flex flex-col gap-2 text-[14px]">
          <div className="text-[12px] text-ink-muted">
            {lesson.clientName} · {ctx.date}
          </div>
          {note.headline && <div className="font-bold">{note.headline}</div>}
          {note.keyPoints.length > 0 && (
            <div>
              <div className="text-[12px] text-emerald-300 font-bold mb-1">{L.keyPoints}</div>
              <ul className="list-disc pl-5 flex flex-col gap-1">
                {note.keyPoints.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="text-[12px] text-ink-muted break-all pt-1">{url}</div>
        </div>

        <div className="flex flex-col gap-2">
          {shareResult === 'copied' && (
            <p role="status" className="text-[13px] text-emerald-300 text-center">
              {T.copiedForPaste}
            </p>
          )}
          <button
            type="button"
            onClick={() => void shareNote(note, ctx).then(setShareResult)}
            className="h-12 rounded-xl bg-emerald-500 text-black font-bold text-[15px] flex items-center justify-center gap-2"
          >
            <Send className="w-4 h-4" />
            {T.shareAgain}
          </button>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(url)
                .then(() => setCopied(true))
                .catch(() => {});
            }}
            className="h-12 rounded-xl border border-line-subtle text-[15px] flex items-center justify-center gap-2"
          >
            <Copy className="w-4 h-4" />
            {copied ? T.copied : T.copyLink}
          </button>
          <button
            type="button"
            onClick={onDone}
            className="h-12 rounded-xl text-[15px] text-ink-medium flex items-center justify-center gap-2"
          >
            <Mic className="w-4 h-4" />
            {T.newLesson}
          </button>
        </div>
      </main>
    </div>
  );
};
