import { jsonAuthHeaders, resolveApiBaseUrl } from './apiBase';
import { isSupabaseMode, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../utils/supabaseMode';

/**
 * AI 게이트웨이(비스트리밍)를 어디로, 어떤 토큰으로 부를지.
 *  - 기본(Express): `<API>/api/ai/invoke`, 서버 로그인 토큰.
 *  - Supabase 모드: Edge Function `ai-invoke`, Supabase 로그인 토큰.
 * 두 쪽 모두 응답은 `{ ok, result: { text, model } }` 로 같다.
 */
export interface AiTarget {
  url: string;
  headers: Record<string, string>;
}

const expressInvokeUrl = (): string => {
  const base = resolveApiBaseUrl();
  if (base) return `${base}/api/ai/invoke`;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/api/ai/invoke`;
  }
  return '/api/ai/invoke';
};

export const resolveAiTarget = async (): Promise<AiTarget> => {
  if (!isSupabaseMode()) {
    return { url: expressInvokeUrl(), headers: jsonAuthHeaders() };
  }
  const { getSupabaseAccessToken } = await import('./supabaseClient');
  const token = await getSupabaseAccessToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_PUBLISHABLE_KEY,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return { url: `${SUPABASE_URL}/functions/v1/ai-invoke`, headers };
};
