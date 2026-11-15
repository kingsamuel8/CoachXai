/**
 * ai-invoke — Supabase 판 AI 게이트웨이 (Express POST /api/ai/invoke 와 같은 계약).
 *
 * 요청:  POST { feature, payload: { prompt?, systemInstruction?, mediaParts?,
 *               responseMimeType?, responseSchema?, temperature?, model? } }
 *        Authorization: Bearer <Supabase 로그인 토큰>
 * 응답:  200 { ok: true, result: { text, model } }
 *        401 로그인 안 됨 · 403 코치 아님 · 429 분당 한도 초과 · 4xx/5xx { ok:false, error, fallback:true }
 *
 * 지키는 것
 *  - 서버의 Gemini 키(GEMINI_API_KEY 비밀값)는 로그인한 **코치**만 쓴다.
 *    코치 = coaches 표에 자기 행이 있는 Supabase 사용자(가입 트리거가 만든다).
 *  - 코치마다 분당 호출 수 제한(AI_RATE_LIMIT_PER_MIN, 기본 60). ai_interactions 의
 *    최근 1분 기록으로 센다.
 *  - 모델·온도는 Express 게이트웨이와 같다(_shared/aiRouting.ts). 라우팅된 모델이
 *    404/429 면 기본 모델로 한 번 폴백한다.
 *  - 호출 기록(ai_interactions)에는 메타데이터만 남긴다. 프롬프트·응답 원문은
 *    저장하지 않는다(학습 데이터 동의 흐름은 아직 Supabase 로 옮기지 않았다).
 */
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import { DEFAULT_MODEL, resolveModel, resolveTemperature } from '../_shared/aiRouting.ts';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });

const MAX_RETRY_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 500;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

class GeminiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type RuntimePart = { text: string } | { inlineData: { data: string; mimeType: string } };

const isRuntimePart = (p: unknown): p is RuntimePart => {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  if (typeof r.text === 'string') return true;
  const d = r.inlineData as Record<string, unknown> | undefined;
  return !!d && typeof d.data === 'string' && typeof d.mimeType === 'string';
};

interface GeminiRequest {
  model: string;
  prompt?: string;
  parts: RuntimePart[];
  systemInstruction?: string;
  responseMimeType?: string;
  responseSchema?: unknown;
  temperature?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** server/src/services/geminiApiRuntime.ts invokeGeminiApi 와 같은 요청 모양·재시도. */
async function callGemini(apiKey: string, req: GeminiRequest): Promise<{ text: string; model: string }> {
  const mapped = req.parts.map((p) =>
    'text' in p ? { text: p.text } : { inline_data: { data: p.inlineData.data, mime_type: p.inlineData.mimeType } }
  );
  const contentParts = mapped.length > 0
    ? (req.prompt ? [{ text: req.prompt }, ...mapped] : mapped)
    : (req.prompt ? [{ text: req.prompt }] : []);
  const body = {
    contents: [{ role: 'user', parts: contentParts }],
    ...(req.systemInstruction ? { systemInstruction: { parts: [{ text: req.systemInstruction }] } } : {}),
    generationConfig: {
      ...(req.responseMimeType ? { responseMimeType: req.responseMimeType } : {}),
      ...(req.responseSchema ? { responseSchema: req.responseSchema } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    },
  };
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent`;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastError = e;
      if (attempt < MAX_RETRY_ATTEMPTS - 1) {
        await sleep(INITIAL_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      throw new Error(`Gemini API network error: ${e instanceof Error ? e.message : String(e)}`);
    }
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = payload.error as Record<string, unknown> | undefined;
      const msg = typeof err?.message === 'string' ? err.message : JSON.stringify(payload).slice(0, 400);
      const e = new GeminiError(`Gemini API request failed (${res.status}): ${msg}`, res.status);
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRY_ATTEMPTS - 1) {
        lastError = e;
        await sleep(INITIAL_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      throw e;
    }
    const cand = (payload.candidates as Array<Record<string, unknown>> | undefined)?.[0];
    const parts = (cand?.content as Record<string, unknown> | undefined)?.parts as
      | Array<Record<string, unknown>>
      | undefined;
    const texts = (parts ?? []).filter((p) => typeof p.text === 'string').map((p) => p.text as string);
    if (texts.length > 0) return { text: texts.join('\n'), model: req.model };
    throw new Error('Gemini API returned an empty response.');
  }
  throw lastError instanceof Error ? lastError : new Error('Gemini API request failed after retries.');
}

async function sha12(text: string | undefined): Promise<string | null> {
  if (!text) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });

  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const apiKey = (Deno.env.get('GEMINI_API_KEY') ?? '').trim();
  const defaultModel = (Deno.env.get('GEMINI_MODEL') ?? '').trim() || DEFAULT_MODEL;
  const perMinute = Number(Deno.env.get('AI_RATE_LIMIT_PER_MIN')) > 0
    ? Number(Deno.env.get('AI_RATE_LIMIT_PER_MIN'))
    : 60;

  // 1) 로그인한 코치인가
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json(401, { ok: false, error: 'Missing authorization token' });
  const asUser = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await asUser.auth.getUser();
  const user = userData?.user;
  if (userError || !user) return json(401, { ok: false, error: 'Invalid or expired token' });
  // RLS 가 자기 행만 보여 주므로, 행이 있으면 코치다.
  const { data: coachRow } = await asUser.from('coaches').select('id').eq('id', user.id).maybeSingle();
  if (!coachRow) return json(403, { ok: false, error: 'AI is available to signed-in coaches only' });

  // 2) 분당 한도
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await admin
    .from('ai_interactions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .gte('occurred_at', since);
  if ((count ?? 0) >= perMinute) {
    return json(429, { ok: false, error: 'Too many AI requests — try again in a minute' });
  }

  // 3) 요청 해석
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }
  const feature = body.feature;
  if (!feature || typeof feature !== 'string') return json(400, { ok: false, error: 'feature is required' });
  const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
    ? (body.payload as Record<string, unknown>)
    : {};
  if (!apiKey) return json(503, { ok: false, error: 'Gemini API is not configured', fallback: true });

  const parts = (Array.isArray(payload.mediaParts) ? payload.mediaParts : []).filter(isRuntimePart);
  const geminiReq: GeminiRequest = {
    model: resolveModel(feature, payload.model, defaultModel),
    prompt: typeof payload.prompt === 'string' ? payload.prompt : undefined,
    parts,
    systemInstruction: typeof payload.systemInstruction === 'string' ? payload.systemInstruction : undefined,
    responseMimeType: typeof payload.responseMimeType === 'string' ? payload.responseMimeType : undefined,
    responseSchema: payload.responseSchema && typeof payload.responseSchema === 'object'
      ? payload.responseSchema
      : undefined,
    temperature: resolveTemperature(feature, payload.temperature),
  };

  const log = (row: Record<string, unknown>) =>
    admin.from('ai_interactions').insert({
      user_id: user.id,
      user_role: 'coach',
      feature,
      model: geminiReq.model,
      runtime: 'supabase_edge',
      prompt_chars: (geminiReq.prompt?.length ?? 0) + (geminiReq.systemInstruction?.length ?? 0),
      has_schema: Boolean(geminiReq.responseSchema),
      media_part_count: parts.length,
      latency_ms: Date.now() - startedAt,
      ...row,
    }).then(({ error }) => {
      if (error) console.warn('[ai-invoke] failed to log interaction:', error.message);
    });
  const promptHash = await sha12(geminiReq.prompt);

  // 4) Gemini 호출 (+ 기본 모델 폴백 1회)
  try {
    let result: { text: string; model: string };
    try {
      result = await callGemini(apiKey, geminiReq);
    } catch (e) {
      const canFallback = e instanceof GeminiError && (e.status === 404 || e.status === 429) &&
        geminiReq.model !== defaultModel;
      if (!canFallback) throw e;
      await log({ prompt_hash: promptHash, status: 'fallback', error_message: (e as Error).message });
      result = await callGemini(apiKey, { ...geminiReq, model: defaultModel });
    }
    await log({
      model: result.model,
      prompt_hash: promptHash,
      response_chars: result.text.length,
      latency_ms: Date.now() - startedAt,
      status: 'success',
    });
    return json(200, { ok: true, result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await log({ prompt_hash: promptHash, status: 'error', error_message: message.slice(0, 500) });
    console.error('[ai-invoke] error:', message);
    const status = e instanceof GeminiError && e.status >= 400 && e.status < 600 ? e.status : 500;
    return json(status, { ok: false, error: 'AI gateway error', fallback: true });
  }
});
