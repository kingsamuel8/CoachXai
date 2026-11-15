/**
 * Supabase 모드 — Express 서버 없이 Supabase 만으로 녹음 → 정리 → 전달을 돌린다
 * (Supabase 이전 1단계, docs/SUPABASE_DB.md).
 *
 *  - 켜기: 주소에 `?supabase=1`(이 기기에 기억된다), 끄기: `?supabase=0`.
 *    빌드 때 `VITE_BACKEND=supabase` 면 항상 켜진다.
 *  - 로그인: Supabase Auth(이메일·비밀번호). 가입하면 DB 트리거가 코치 행을 만든다.
 *  - 저장: 레슨·고객·용어 사전을 Supabase 표에 직접 읽고 쓴다(RLS 로 자기 것만).
 *  - AI: Supabase Edge Function `ai-invoke`(로그인한 코치만, 분당 제한).
 *  - 전달: 공유 토큰 링크(`?note=<64자 토큰>`), 고객은 get_public_lesson_note 로 연다.
 *
 * 아직 단순 코치 화면만 옮겼다. 예약·결제 같은 전체 기능은 Express 모드에서 쓴다.
 */
const FLAG_KEY = 'coachxai_supabase_mode';

/** 공개 값이다(브라우저에 나가는 publishable 키). 빌드 환경 변수로 바꿀 수 있다. */
export const SUPABASE_URL: string =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ||
  'https://hjbgdgwupbmcbqjtufzj.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY: string =
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)?.trim() ||
  'sb_publishable_sk76m6b6aySKu36hmyuMhw_CtCjqCpc';

const read = (): string => {
  try {
    return localStorage.getItem(FLAG_KEY) ?? '';
  } catch {
    return '';
  }
};

const write = (value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(FLAG_KEY);
    else localStorage.setItem(FLAG_KEY, value);
  } catch {
    // 저장이 막힌 브라우저에서는 주소에 ?supabase=1 이 있을 때만 켜진다.
  }
};

export const isSupabaseMode = (): boolean =>
  import.meta.env.VITE_BACKEND === 'supabase' || read() === '1';

/** 주소의 `?supabase=1|0` 을 반영하고, 지금 Supabase 모드인지 돌려준다. */
export const syncSupabaseModeFromUrl = (search: string): boolean => {
  const flag = new URLSearchParams(search).get('supabase');
  if (flag === '1') write('1');
  if (flag === '0') write(null);
  return isSupabaseMode() || flag === '1';
};

export const exitSupabaseMode = (): void => write(null);

/**
 * Supabase 가 만든 공유 토큰인지. share_lesson() 은 64자 16진수를 만들고,
 * Express 는 22자 base64url 을 만든다 — 링크를 연 고객의 브라우저는 모드
 * 설정이 없으므로 토큰 모양으로 어느 쪽에 물을지 고른다.
 */
export const isSupabaseNoteToken = (token: string): boolean => /^[0-9a-f]{64}$/.test(token);
