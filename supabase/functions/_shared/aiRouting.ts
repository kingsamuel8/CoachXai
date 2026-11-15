/**
 * AI 게이트웨이 라우팅 — Supabase Edge Function(ai-invoke)용.
 *
 * Express 게이트웨이(server/src/services/modelRouter.ts, aiTemperature.ts)와
 * **같은 값**이어야 한다. 그래야 서버에서 보던 정확도가 그대로 나온다.
 * __tests__/aiRoutingParity.test.ts 가 둘이 같은지 확인하므로 한쪽만 고치면
 * 테스트가 실패한다. Deno·Node 양쪽에서 읽히도록 순수 TS 로만 둔다.
 */

export const DEFAULT_MODEL = 'gemini-2.5-flash';

export const FEATURE_MODEL_OVERRIDES: Record<string, string> = {
  extract_golf_data: "gemini-2.5-flash-lite",
  analyze_trackman_screen: "gemini-2.5-flash-lite",
  analyze_body_photos: "gemini-2.5-flash-lite",
  analyze_equipment_photo: "gemini-2.5-flash-lite",
  swing_phase_timestamps: "gemini-2.5-flash-lite",
  hole_voice_summary: "gemini-2.5-flash-lite",
  lesson_summary: "gemini-3.1-pro-preview",
  lesson_summary_merge: "gemini-3.1-pro-preview",
  lesson_live_summary: "gemini-3.1-pro-preview",
  lesson_dual_summary: "gemini-3.1-pro-preview",
  lesson_audio_transcribe: "gemini-3.6-flash",
  lesson_audio_live_transcribe: "gemini-3.6-flash",
  lesson_audio_precise_transcribe: "gemini-3.1-pro-preview",
  lesson_speaker_label: "gemini-3.6-flash",
  lesson_transcript_repair: "gemini-3.6-flash",
  lesson_audio_term_verify: "gemini-3.1-pro-preview",
  lesson_transcript_final_repair: "gemini-3.1-pro-preview",
  lesson_client_note: "gemini-3.1-pro-preview",
};

export const DEFAULT_TEMPERATURE_BY_FEATURE: Record<string, number> = {
  extract_golf_data: 0.1,
  analyze_trackman_screen: 0.1,
  analyze_equipment_photo: 0.1,
  analyze_body_photos: 0.2,
  swing_phase_timestamps: 0.2,
  hole_voice_summary: 0.2,
  motion_capture_analysis: 0.3,
  lesson_audio_segment: 0.2,
  lesson_audio_transcribe: 0.1,
  lesson_audio_live_transcribe: 0.1,
  lesson_audio_precise_transcribe: 0.1,
  lesson_speaker_label: 0.1,
  lesson_transcript_repair: 0.1,
  lesson_transcript_final_repair: 0.1,
  lesson_audio_term_verify: 0.1,
  lesson_summary: 0.4,
  lesson_summary_merge: 0.4,
  lesson_live_summary: 0.3,
  lesson_dual_summary: 0.3,
  lesson_client_note: 0.3,
  compare_swings: 0.4,
  weekly_insight: 0.5,
  coachx_insights: 0.6,
  training_program: 0.7,
  golf_missions: 0.7,
  coachx_chat: 0.7,
  student_chat: 0.7,
  coachx_growth_profile: 0.7,
  generate_system_prompt: 0.4,
  generate_interview_question: 0.7,
  shot_analysis: 0.3,
  swing_coaching_report: 0.35,
};

export const resolveModel = (feature: string, explicit: unknown, defaultModel: string): string => {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  return FEATURE_MODEL_OVERRIDES[feature] ?? defaultModel;
};

export const resolveTemperature = (feature: string, explicit: unknown): number | undefined =>
  typeof explicit === 'number' ? explicit : DEFAULT_TEMPERATURE_BY_FEATURE[feature];
