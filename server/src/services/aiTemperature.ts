/**
 * 기능별 기본 온도 — AI 게이트웨이(routes/ai.ts)와 Supabase Edge Function
 * (supabase/functions/_shared/aiRouting.ts)이 같은 값을 써야 한다.
 * __tests__/aiRoutingParity.test.ts 가 둘이 같은지 확인한다.
 */
// Per-feature default temperatures.
// Applied only when the client did not send an explicit temperature.
// Rationale: JSON extraction / OCR-style features need low creativity for
// accurate readings; conversational / analytical features need higher.
export const DEFAULT_TEMPERATURE_BY_FEATURE: Record<string, number> = {
  // OCR / structured data extraction — must read numbers accurately.
  extract_golf_data: 0.1,
  analyze_trackman_screen: 0.1,
  analyze_equipment_photo: 0.1,
  analyze_body_photos: 0.2,
  swing_phase_timestamps: 0.2,
  hole_voice_summary: 0.2,
  motion_capture_analysis: 0.3,

  // 레슨 오디오 세그먼트 전사+노트 추출 — 들리는 내용에 충실해야 하므로
  // OCR 수준으로 낮게 유지한다.
  lesson_audio_segment: 0.2,
  // 구간 받아쓰기(필기 노트) — 순수 전사라 최저 온도.
  lesson_audio_transcribe: 0.1,
  // 라이브 받아쓰기(2초 조각) — 같은 이유로 최저 온도.
  lesson_audio_live_transcribe: 0.1,
  // 검토 단계의 정밀 전사(5분 조각 통째 받아쓰기) — 같은 이유로 최저 온도.
  lesson_audio_precise_transcribe: 0.1,
  // 필기 줄마다 화자 역할(코치/학생/주변) 배정 — 분류 작업이라 최저 온도.
  lesson_speaker_label: 0.1,
  // 오인식된 골프 용어를 코칭 언어로 되돌리는 교정 — 정해진 어휘로
  // 되돌리는 작업이라 창의성이 곧 오류다. 전사와 같은 최저 온도.
  lesson_transcript_repair: 0.1,
  // 검토 단계의 최종 교정(pro)·오디오 대조 교정 — 같은 이유로 최저 온도.
  lesson_transcript_final_repair: 0.1,
  lesson_audio_term_verify: 0.1,

  // Analytical / summarization — mostly deterministic with light phrasing.
  lesson_summary: 0.4,
  // 세그먼트 노트 → 최종 리포트 병합(map-reduce reduce 단계). 톤은
  // lesson_summary 와 동일하게 맞춘다.
  lesson_summary_merge: 0.4,
  // 레슨 진행 중 화면에 띄우는 롤링 요약 — 짧은 불릿 재생성이 잦으므로
  // 흔들림 없이 노트에 충실해야 한다.
  lesson_live_summary: 0.3,
  // 코치 요약 + 학생 요약 — 근거가 화자별 발화로 갈려 있어 롤링 요약과
  // 같은 수준으로 필기에 충실해야 한다.
  lesson_dual_summary: 0.3,
  // 고객용 레슨 노트 — 필기에 충실하되 고객이 읽기 쉬운 문장이어야 한다.
  lesson_client_note: 0.3,
  compare_swings: 0.4,
  weekly_insight: 0.5,
  coachx_insights: 0.6,

  // Generative / conversational — needs warmth and variety.
  training_program: 0.7,
  golf_missions: 0.7,
  coachx_chat: 0.7,
  student_chat: 0.7,
  coachx_growth_profile: 0.7,

  // Meta-extraction — reading a coach's document to produce a systemPrompt.
  // Moderate temp: enough creativity to phrase well, low enough to stay faithful.
  generate_system_prompt: 0.4,

  // Interview mode — AI asks coach one question at a time to extract
  // methodology. Higher temp keeps the questions varied and probing.
  generate_interview_question: 0.7,

  // Shot data synthesis — data-heavy analytical report. Low temp keeps
  // numbers and conclusions faithful to the input data.
  shot_analysis: 0.3,

  // Swing coaching report — cross-references pose metrics with student
  // shot / lesson history. Must quote exact numbers back verbatim, so we
  // stay on the low side; a bit above OCR because the prose bits
  // (headline, recommendations) benefit from mild variety.
  swing_coaching_report: 0.35,
};

export const resolveTemperature = (
  feature: string,
  explicit: number | undefined
): number | undefined => {
  if (explicit !== undefined) return explicit;
  return DEFAULT_TEMPERATURE_BY_FEATURE[feature];
};
