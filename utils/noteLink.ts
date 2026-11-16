/**
 * 서버 없이 여는 레슨 노트 링크 — 노트 내용을 링크의 `#` 뒤에 담는다.
 *
 * `#` 뒤(fragment)는 브라우저가 서버로 보내지 않는다. 그래서 웹 앱 정적 파일만
 * 있으면 열리고, 노트 내용이 호스팅 서버 로그에도 남지 않는다. 테스트 모드의
 * 전달 방식이다(서버 모드는 짧은 토큰 링크 ?note=<토큰> 을 쓴다).
 */
import type { PublicLessonNote } from '../services/apiService';
import type { LessonClientNote } from '../types';
import { publicAppBaseUrl } from './publicAppUrl';

const toBase64Url = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (encoded: string): string => {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

/** 링크에 담는 내용 — 공유 링크 응답과 같은 모양이다(노트만, 필기·전화번호 없음). */
export const encodeNoteLink = (ctx: {
  coachName: string;
  studentName: string;
  date: string;
  note: LessonClientNote;
}): string => {
  const payload: PublicLessonNote = {
    coachName: ctx.coachName,
    studentName: ctx.studentName,
    date: ctx.date,
    note: ctx.note,
    fallbackSummary: '',
  };
  return `${publicAppBaseUrl()}/#note=${toBase64Url(JSON.stringify(payload))}`;
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** 주소의 `#note=` 를 노트로 읽는다. 없거나 깨졌으면 null. */
export const decodeNoteLink = (hash: string): PublicLessonNote | null => {
  const m = hash.match(/^#note=([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  try {
    const raw = JSON.parse(fromBase64Url(m[1])) as Record<string, unknown>;
    const n = (raw.note ?? null) as Record<string, unknown> | null;
    if (!n) return null;
    return {
      coachName: str(raw.coachName),
      studentName: str(raw.studentName),
      date: str(raw.date),
      note: {
        language: str(n.language),
        headline: str(n.headline),
        keyPoints: list(n.keyPoints),
        drills: list(n.drills),
        nextFocus: str(n.nextFocus),
        message: str(n.message),
      },
      fallbackSummary: '',
    };
  } catch {
    return null;
  }
};
