/**
 * 테스트 모드의 AI 호출 — 서버 게이트웨이 대신 브라우저가 Gemini 를 직접 부른다.
 *
 * 요청 모양·모델 선택·온도는 서버(server/src/services/geminiApiRuntime.ts,
 * modelRouter.ts, routes/ai.ts)와 맞춘다. 그래야 테스트에서 본 정확도가 서버로
 * 옮겼을 때도 그대로다.
 */
import { getTestGeminiKey } from '../utils/testMode';

const PRO = 'gemini-3.1-pro-preview';
const FLASH = 'gemini-3.6-flash';
const DEFAULT_MODEL = 'gemini-2.5-flash';

/** 서버 modelRouter 의 레슨 경로 라우팅과 같다. */
const MODEL_BY_FEATURE: Record<string, string> = {
  lesson_audio_transcribe: FLASH,
  lesson_audio_live_transcribe: FLASH,
  lesson_speaker_label: FLASH,
  lesson_transcript_repair: FLASH,
  lesson_audio_precise_transcribe: PRO,
  lesson_audio_term_verify: PRO,
  lesson_transcript_final_repair: PRO,
  lesson_summary: PRO,
  lesson_summary_merge: PRO,
  lesson_live_summary: PRO,
  lesson_dual_summary: PRO,
  lesson_client_note: PRO,
};

/** 서버 routes/ai.ts 의 기본 온도와 같다. */
const TEMPERATURE_BY_FEATURE: Record<string, number> = {
  lesson_audio_segment: 0.2,
  lesson_audio_transcribe: 0.1,
  lesson_audio_live_transcribe: 0.1,
  lesson_audio_precise_transcribe: 0.1,
  lesson_audio_term_verify: 0.1,
  lesson_speaker_label: 0.1,
  lesson_transcript_repair: 0.1,
  lesson_transcript_final_repair: 0.1,
  lesson_summary: 0.4,
  lesson_summary_merge: 0.4,
  lesson_live_summary: 0.3,
  lesson_dual_summary: 0.3,
  lesson_client_note: 0.3,
};

export const modelForFeature = (feature: string): string =>
  MODEL_BY_FEATURE[feature] ?? DEFAULT_MODEL;

export class TestModeKeyMissingError extends Error {
  constructor() {
    super('테스트 모드: Gemini API 키가 없습니다. 테스트 설정에서 키를 넣어 주세요.');
    this.name = 'TestModeKeyMissingError';
  }
}

interface Payload {
  prompt?: unknown;
  systemInstruction?: unknown;
  mediaParts?: unknown;
  responseMimeType?: unknown;
  responseSchema?: unknown;
  temperature?: unknown;
}

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const buildGeminiRequestBody = (feature: string, raw: unknown): Record<string, unknown> => {
  const payload = (raw && typeof raw === 'object' ? raw : {}) as Payload;
  const media = Array.isArray(payload.mediaParts)
    ? (payload.mediaParts as Array<{ inlineData?: { data?: string; mimeType?: string } }>)
        .filter((m) => m?.inlineData?.data)
        .map((m) => ({
          inline_data: { data: m.inlineData!.data, mime_type: m.inlineData!.mimeType },
        }))
    : [];
  const temperature =
    typeof payload.temperature === 'number'
      ? payload.temperature
      : TEMPERATURE_BY_FEATURE[feature];
  return {
    contents: [
      {
        role: 'user',
        parts: [...(payload.prompt ? [{ text: String(payload.prompt) }] : []), ...media],
      },
    ],
    ...(payload.systemInstruction
      ? { systemInstruction: { parts: [{ text: String(payload.systemInstruction) }] } }
      : {}),
    generationConfig: {
      ...(payload.responseMimeType ? { responseMimeType: payload.responseMimeType } : {}),
      ...(payload.responseSchema ? { responseSchema: payload.responseSchema } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    },
  };
};

/** Gemini 를 직접 불러 응답 텍스트를 돌려준다(invokeBackendAI 의 테스트 모드 대역). */
export const callGeminiDirect = async (feature: string, payload: unknown): Promise<string> => {
  const apiKey = getTestGeminiKey();
  if (!apiKey) throw new TestModeKeyMissingError();
  const body = JSON.stringify(buildGeminiRequestBody(feature, payload));

  let model = modelForFeature(feature);
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body,
      }
    );
    if (res.ok) {
      const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
      };
      const text = (json.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => typeof p.text === 'string' && !p.thought)
        .map((p) => p.text)
        .join('');
      if (!text.trim()) throw new Error(`${feature}: Gemini 응답이 비어 있습니다.`);
      return text;
    }
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    lastError = new Error(`${feature} (${model}) HTTP ${res.status}: ${detail}`);
    // 서버와 같이: 모델이 없거나(404) 한도에 걸리면(429) 기본 모델로 한 번 바꿔 본다.
    if ((res.status === 404 || res.status === 429) && model !== DEFAULT_MODEL) {
      model = DEFAULT_MODEL;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(1_500 * 2 ** attempt);
      continue;
    }
    break; // 400·401·403 은 키·요청 문제라 다시 해도 같다.
  }
  throw lastError ?? new Error(`${feature}: Gemini 호출 실패`);
};
