import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../utils/supabaseMode';

/**
 * 앱 전체가 쓰는 Supabase 클라이언트 하나. Supabase 모드에서만 불러온다
 * (다른 모드의 번들에 끼지 않도록 이 모듈은 동적 import 로만 쓴다).
 */
let client: SupabaseClient | null = null;

export const getSupabase = (): SupabaseClient => {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: 'coachxai_supabase_auth',
      },
    });
  }
  return client;
};

/** 지금 로그인 토큰(만료가 가까우면 supabase-js 가 새로 받아 둔 것). 없으면 null. */
export const getSupabaseAccessToken = async (): Promise<string | null> => {
  const { data } = await getSupabase().auth.getSession();
  return data.session?.access_token ?? null;
};
