/**
 * 테스트 모드 — 서버(Render 백엔드) 없이 녹음 → 정리 → 전달을 시험해 보는 모드.
 *
 *  - 들어가기: 주소에 `?test=1` 을 붙여 연다(이 기기에 기억된다). `?test=0` 으로 끈다.
 *    빌드 때 `VITE_TEST_MODE=true` 면 항상 켜진다.
 *  - AI: 테스트하는 사람이 넣은 자기 Gemini API 키로 브라우저가 Gemini 를 직접
 *    부른다(services/testGemini.ts). 키는 이 기기에만 저장된다.
 *  - 저장: 레슨은 이 기기 안에만 남는다(services/testLessonStore.ts).
 *  - 전달: 노트 내용을 링크에 담아 보낸다(utils/noteLink.ts) — 서버가 없어도 열린다.
 *
 * 내부 테스트용이다. 고객에게 배포하는 앱에서는 서버 모드를 쓴다 — 브라우저에
 * API 키를 두는 구조는 테스트하는 본인의 키일 때만 괜찮다.
 */
const FLAG_KEY = 'coachxai_test_mode';
const GEMINI_KEY = 'coachxai_test_gemini_key';
const COACH_NAME_KEY = 'coachxai_test_coach_name';

const read = (key: string): string => {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};

const write = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 저장이 막힌 브라우저에서는 이번 실행 동안만 유지된다.
  }
};

/** 주소의 `?test=1|0` 을 반영하고, 지금 테스트 모드인지 돌려준다. */
export const syncTestModeFromUrl = (search: string): boolean => {
  const flag = new URLSearchParams(search).get('test');
  if (flag === '1') write(FLAG_KEY, '1');
  if (flag === '0') write(FLAG_KEY, null);
  return isTestMode();
};

export const isTestMode = (): boolean =>
  import.meta.env.VITE_TEST_MODE === 'true' || read(FLAG_KEY) === '1';

export const exitTestMode = (): void => write(FLAG_KEY, null);

export const getTestGeminiKey = (): string => read(GEMINI_KEY).trim();
export const setTestGeminiKey = (key: string): void => write(GEMINI_KEY, key.trim() || null);

export const getTestCoachName = (): string => read(COACH_NAME_KEY).trim();
export const setTestCoachName = (name: string): void => write(COACH_NAME_KEY, name.trim() || null);
