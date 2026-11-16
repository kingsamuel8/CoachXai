/**
 * lessonClientNote — 고객에게 보내는 레슨 노트.
 *
 * 이 서비스의 결과물은 결국 이 노트 한 장이다: 코치가 레슨을 녹음하면, 필기에서
 * 고객이 기억해야 할 것만 골라 **고객이 읽는 언어로** 정리해 링크로 보낸다.
 * 코치 요약(코치 시점의 교정 기록)이나 필기 전문과 달리, 읽는 사람이 고객이다 —
 * 그래서 짧고, 따라 할 수 있고, 다음에 무엇을 할지가 분명해야 한다.
 */
import { invokeBackendAI, getResponseText } from './geminiService';
import type { LessonClientNote } from '../types';

export type NoteLanguage = 'ko' | 'en' | 'ja' | 'th';

export const NOTE_LANGUAGES: Record<NoteLanguage, string> = {
  ko: '한국어',
  en: 'English',
  ja: '日本語',
  th: 'ภาษาไทย',
};

/** 노트에 붙는 소제목·문구. 공유 문자와 공개 노트 화면이 같이 쓴다. */
export const NOTE_LABELS: Record<
  NoteLanguage,
  {
    title: string;
    keyPoints: string;
    drills: string;
    nextFocus: string;
    from: (coach: string) => string;
    forStudent: (student: string) => string;
    openLink: string;
  }
> = {
  ko: {
    title: '레슨 노트',
    keyPoints: '오늘의 핵심',
    drills: '연습 과제',
    nextFocus: '다음 레슨',
    from: (c) => `${c} 코치`,
    forStudent: (s) => `${s}님`,
    openLink: '레슨 노트 보기',
  },
  en: {
    title: 'Lesson Notes',
    keyPoints: 'Key points',
    drills: 'Practice',
    nextFocus: 'Next lesson',
    from: (c) => `Coach ${c}`,
    forStudent: (s) => `For ${s}`,
    openLink: 'Open lesson notes',
  },
  ja: {
    title: 'レッスンノート',
    keyPoints: '今日のポイント',
    drills: '練習課題',
    nextFocus: '次回のレッスン',
    from: (c) => `${c} コーチ`,
    forStudent: (s) => `${s} さん`,
    openLink: 'レッスンノートを見る',
  },
  th: {
    title: 'บันทึกบทเรียน',
    keyPoints: 'ประเด็นสำคัญ',
    drills: 'แบบฝึกหัด',
    nextFocus: 'บทเรียนครั้งหน้า',
    from: (c) => `โค้ช ${c}`,
    forStudent: (s) => `สำหรับ ${s}`,
    openLink: 'เปิดบันทึกบทเรียน',
  },
};

export const isNoteLanguage = (v: unknown): v is NoteLanguage =>
  v === 'ko' || v === 'en' || v === 'ja' || v === 'th';

/** 필기가 너무 길면 앞뒤를 남기고 가운데를 줄인다 — 핵심은 대개 끝부분 정리에 몰린다. */
const MAX_TRANSCRIPT_CHARS = 60_000;
const clipTranscript = (text: string): string => {
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
  const head = text.slice(0, MAX_TRANSCRIPT_CHARS * 0.4);
  const tail = text.slice(-MAX_TRANSCRIPT_CHARS * 0.6);
  return `${head}\n…\n${tail}`;
};

export const buildClientNotePrompt = (ctx: {
  studentName: string;
  coachName: string;
  language: NoteLanguage;
  transcript: string;
  coachSummary?: string;
}): string => {
  const lang = NOTE_LANGUAGES[ctx.language];
  const summary = ctx.coachSummary?.trim()
    ? `\nThe coach's own summary of the lesson (already reviewed by the coach — trust it):\n${ctx.coachSummary.trim()}\n`
    : '';
  return `You write the lesson notes a golf coach sends to their student after a lesson.
Coach: ${ctx.coachName || 'the coach'}. Student: ${ctx.studentName}.

Below is the transcript of the lesson (it may be in any language, may contain speech-recognition errors, small talk, and lines from other people nearby).${summary}
Transcript:
${clipTranscript(ctx.transcript)}

Write the notes **in ${lang}**, addressed to the student, in the coach's voice. Return one JSON object:
{
  "headline": "one sentence: what today's lesson was about",
  "keyPoints": ["3 to 5 things the student should remember — concrete, actionable, in the coach's words"],
  "drills": ["practice tasks to do before the next lesson (0 to 3), with reps or details if the coach said them"],
  "nextFocus": "what the next lesson will work on, one sentence ('' if the coach did not say)",
  "message": "one short encouraging line from the coach ('' if nothing fits)"
}
Rules:
- Only use what is actually in the transcript or the coach's summary. Do not invent drills, numbers, or advice.
- Leave out small talk, scheduling, payments, and anything unrelated to the student's golf.
- Use standard golf terminology in ${lang}. Keep each item short (one line on a phone screen).
- Keep numbers exactly as said (distances, club numbers, reps).`;
};

const noteSchema = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING' },
    keyPoints: { type: 'ARRAY', items: { type: 'STRING' } },
    drills: { type: 'ARRAY', items: { type: 'STRING' } },
    nextFocus: { type: 'STRING' },
    message: { type: 'STRING' },
  },
  required: ['headline', 'keyPoints', 'drills', 'nextFocus', 'message'],
} as const;

const cleanList = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, max)
    : [];

export const parseClientNoteResponse = (
  text: string,
  language: NoteLanguage
): LessonClientNote | null => {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const note: LessonClientNote = {
      language,
      headline: str(raw.headline),
      keyPoints: cleanList(raw.keyPoints, 6),
      drills: cleanList(raw.drills, 4),
      nextFocus: str(raw.nextFocus),
      message: str(raw.message),
    };
    return note.headline || note.keyPoints.length ? note : null;
  } catch {
    return null;
  }
};

/** 필기로 고객용 노트를 만든다. 실패하면 null — 코치가 직접 쓸 수 있다. */
export const generateClientNote = async (ctx: {
  studentName: string;
  coachName: string;
  language: NoteLanguage;
  transcript: string;
  coachSummary?: string;
}): Promise<LessonClientNote | null> => {
  if (!ctx.transcript.trim() && !ctx.coachSummary?.trim()) return null;
  const result = await invokeBackendAI<unknown>('lesson_client_note', {
    prompt: buildClientNotePrompt(ctx),
    responseMimeType: 'application/json',
    responseSchema: noteSchema,
  });
  return parseClientNoteResponse(getResponseText(result) ?? '', ctx.language);
};

export const emptyClientNote = (language: NoteLanguage): LessonClientNote => ({
  language,
  headline: '',
  keyPoints: [],
  drills: [],
  nextFocus: '',
  message: '',
});

/**
 * 메신저로 보낼 문자. 링크를 못 여는 고객도 노트 내용을 바로 읽을 수 있게
 * 본문을 다 싣고, 끝에 링크를 붙인다.
 */
export const formatClientNoteMessage = (
  note: LessonClientNote,
  ctx: { coachName: string; studentName: string; date: string; url?: string }
): string => {
  const lang = isNoteLanguage(note.language) ? note.language : 'en';
  const L = NOTE_LABELS[lang];
  const lines: string[] = [
    `⛳ ${L.title} · ${ctx.date}`,
    `${L.forStudent(ctx.studentName)} — ${L.from(ctx.coachName)}`,
  ];
  if (note.headline) lines.push('', note.headline);
  if (note.keyPoints.length) {
    lines.push('', `■ ${L.keyPoints}`, ...note.keyPoints.map((p) => `• ${p}`));
  }
  if (note.drills.length) {
    lines.push('', `■ ${L.drills}`, ...note.drills.map((d) => `• ${d}`));
  }
  if (note.nextFocus) lines.push('', `■ ${L.nextFocus}`, note.nextFocus);
  if (note.message) lines.push('', note.message);
  if (ctx.url) lines.push('', `${L.openLink}: ${ctx.url}`);
  return lines.join('\n');
};
