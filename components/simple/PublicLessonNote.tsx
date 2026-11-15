import React, { useEffect, useState } from 'react';
import { apiService, type PublicLessonNote as PublicNote } from '../../services/apiService';
import { NOTE_LABELS, isNoteLanguage, type NoteLanguage } from '../../services/lessonClientNote';
import { isSupabaseNoteToken } from '../../utils/supabaseMode';

/**
 * 코치가 보낸 링크로 고객이 여는 레슨 노트. 로그인·앱 설치 없이 열린다.
 * 휴대폰 브라우저에서 한 화면에 읽히도록 노트만 크게 보여 준다.
 */
const browserLanguage = (): NoteLanguage => {
  const lang = (typeof navigator !== 'undefined' ? navigator.language : 'en').slice(0, 2);
  return isNoteLanguage(lang) ? lang : 'en';
};

const STATUS_TEXT: Record<NoteLanguage, { loading: string; missing: string; error: string }> = {
  ko: { loading: '레슨 노트를 불러오는 중…', missing: '레슨 노트를 찾을 수 없어요. 코치에게 링크를 다시 받아 주세요.', error: '노트를 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.' },
  en: { loading: 'Loading lesson notes…', missing: 'We couldn’t find these lesson notes. Please ask your coach for a new link.', error: 'Couldn’t load the notes. Please try again in a moment.' },
  ja: { loading: 'レッスンノートを読み込んでいます…', missing: 'レッスンノートが見つかりません。コーチにリンクを再送してもらってください。', error: '読み込めませんでした。しばらくしてからもう一度開いてください。' },
  th: { loading: 'กำลังโหลดบันทึกบทเรียน…', missing: 'ไม่พบบันทึกบทเรียนนี้ โปรดขอลิงก์ใหม่จากโค้ช', error: 'โหลดไม่สำเร็จ โปรดลองอีกครั้งในภายหลัง' },
};

/**
 * `token` 이면 서버에서 노트를 받아 오고(서버 모드), `data` 면 링크에 담겨 온
 * 노트를 그대로 그린다(테스트 모드 — utils/noteLink.ts).
 */
export const PublicLessonNote: React.FC<{ token?: string; data?: PublicNote }> = ({
  token,
  data: inline,
}) => {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ready'; data: PublicNote } | { kind: 'missing' } | { kind: 'error' }
  >(inline ? { kind: 'ready', data: inline } : token ? { kind: 'loading' } : { kind: 'missing' });

  useEffect(() => {
    if (inline || !token) return;
    let cancelled = false;
    // Supabase 가 만든 토큰(64자 16진수)은 Supabase 에, 나머지는 Express 에 묻는다.
    const load = isSupabaseNoteToken(token)
      ? import('../../services/supabaseCoachStore').then((m) => m.getPublicNote(token))
      : apiService.getPublicLessonNote(token);
    load
      .then((data) => !cancelled && setState({ kind: 'ready', data }))
      .catch((err: { status?: number }) => {
        if (!cancelled) setState({ kind: err?.status === 404 ? 'missing' : 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [token, inline]);

  const lang: NoteLanguage =
    state.kind === 'ready' && isNoteLanguage(state.data.note?.language)
      ? (state.data.note!.language as NoteLanguage)
      : browserLanguage();
  const L = NOTE_LABELS[lang];

  if (state.kind !== 'ready') {
    const text = STATUS_TEXT[lang][state.kind];
    return (
      <main className="min-h-screen bg-base text-ink-high flex items-center justify-center px-6 text-center">
        <p className="text-[15px] text-ink-medium" role={state.kind === 'loading' ? 'status' : 'alert'}>
          {text}
        </p>
      </main>
    );
  }

  const { data } = state;
  const note = data.note;
  return (
    // 기기 안전 영역(pt-safe/pb-safe)은 바깥에, 여백은 안쪽에 둔다 — 한 요소에
    // 같이 쓰면 안전 영역 규칙이 py-* 를 덮어써 첫 줄이 화면 끝에 붙는다.
    <main className="min-h-screen bg-base text-ink-high pt-safe pb-safe">
      <article className="max-w-xl mx-auto px-4 py-8 flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <div className="text-[12px] font-mono uppercase tracking-wider text-emerald-300">
            ⛳ {L.title} · {data.date}
          </div>
          <h1 className="text-[22px] font-bold leading-snug">
            {note?.headline || L.forStudent(data.studentName)}
          </h1>
          <div className="text-[13px] text-ink-muted">
            {L.forStudent(data.studentName)} · {L.from(data.coachName)}
          </div>
        </header>

        {note ? (
          <>
            {note.keyPoints.length > 0 && (
              <NoteSection title={L.keyPoints}>
                <ol className="flex flex-col gap-2.5">
                  {note.keyPoints.map((p, i) => (
                    <li key={i} className="flex gap-3 text-[15px] leading-relaxed">
                      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-500/15 text-emerald-300 text-[12px] font-bold flex items-center justify-center">
                        {i + 1}
                      </span>
                      <span>{p}</span>
                    </li>
                  ))}
                </ol>
              </NoteSection>
            )}
            {note.drills.length > 0 && (
              <NoteSection title={L.drills}>
                <ul className="flex flex-col gap-2 list-disc pl-5 text-[15px] leading-relaxed">
                  {note.drills.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </NoteSection>
            )}
            {note.nextFocus && (
              <NoteSection title={L.nextFocus}>
                <p className="text-[15px] leading-relaxed">{note.nextFocus}</p>
              </NoteSection>
            )}
            {note.message && (
              <p className="text-[15px] leading-relaxed text-ink-medium border-l-2 border-emerald-400/60 pl-3">
                {note.message}
              </p>
            )}
          </>
        ) : (
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap">{data.fallbackSummary}</p>
        )}
      </article>
    </main>
  );
};

const NoteSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="rounded-2xl border border-line-subtle bg-white/[0.04] p-4 flex flex-col gap-3">
    <h2 className="text-[13px] font-bold text-emerald-300">{title}</h2>
    {children}
  </section>
);
