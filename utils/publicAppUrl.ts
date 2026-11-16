/**
 * 고객에게 보내는 링크의 웹 주소.
 *
 * 링크는 앱이 없는 고객의 휴대폰 브라우저에서 열려야 하므로 언제나 공개
 * 웹 주소여야 한다. 네이티브 앱은 이 웹 주소를 그대로 띄우지만
 * (capacitor.*.config.ts 의 server.url), 로컬 개발·미리보기 주소는 고객이
 * 열 수 없으므로 배포 주소로 대신한다.
 */
const DEPLOYED_WEB_APP = 'https://coach-xai.vercel.app';

export const publicAppBaseUrl = (): string => {
  const env = (import.meta.env.VITE_PUBLIC_APP_URL as string | undefined)?.trim();
  if (env) return env.replace(/\/+$/, '');
  if (typeof window !== 'undefined') {
    const { protocol, hostname, origin } = window.location;
    const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.local');
    if ((protocol === 'https:' || protocol === 'http:') && !local) return origin;
  }
  return DEPLOYED_WEB_APP;
};

/** 공유 토큰 → 고객이 여는 레슨 노트 링크. 경로 대신 쿼리를 쓴다(정적 호스팅의 경로 재작성 없이도 열린다). */
export const lessonNoteUrl = (token: string): string =>
  `${publicAppBaseUrl()}/?note=${encodeURIComponent(token)}`;

/** 현재 주소가 공유 노트 링크면 그 토큰. */
export const readLessonNoteToken = (search: string): string | null => {
  const token = new URLSearchParams(search).get('note');
  return token && /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : null;
};
