/**
 * 레슨 요약 — 받아쓰기 텍스트만으로 구조화된 요약(마크다운)을 만든다.
 * (docs/VOICE_RECORDING_PLAN.md §11.5)
 *
 * 프롬프트 v3: PoC v2(scripts/stt-poc/prompts/summary_v2.md, 핵심 포인트 91~98%)에
 * 테스트에서 나온 문제를 고친 것.
 *  - 주제가 10개로 쪼개져 너무 길었다 → 주제 4~6개로 묶기
 *  - 다음 레슨 계획이 숙제로 들어갔다 → 코치가 "연습하라"고 한 것만 숙제
 *  - 실행마다 한두 포인트가 빠졌다 → 마지막에 빠뜨린 교정 포인트를 스스로 점검
 *
 * 요약기는 갈아 끼울 수 있다(Gemini 기본, 이후 Claude 등).
 */
import { invokeGeminiApi, isModelFallbackError } from '../geminiApiRuntime';
import { getDefaultModel, resolveModel } from '../modelRouter';
import type { TranscriptSegment } from './stt';

export const SUMMARY_PROMPT_VERSION = 'v3';

export interface SummaryContext {
  studentName?: string | null;
  /** 지난 레슨 요약(있으면 "좋아진 점 / 반복 지적" 비교에 쓴다). */
  previousSummary?: string | null;
}

export interface Summarizer {
  name: string;
  summarize(prompt: string): Promise<{ text: string; model: string }>;
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** "[mm:ss] 문장" 줄들. 화자 라벨은 현재 엔진에서 믿을 수 없어 넣지 않는다. */
export function renderTranscript(segments: TranscriptSegment[]): string {
  return segments.map((s) => `[${clock(s.startMs)}] ${s.text.trim()}`).join('\n');
}

export function buildSummaryPrompt(segments: TranscriptSegment[], ctx: SummaryContext = {}): string {
  const student = ctx.studentName?.trim() || '학생';
  const previous = ctx.previousSummary?.trim()
    ? `\n## 지난 레슨 요약 (비교용 — 이번 받아쓰기에 근거가 있을 때만 "좋아진 점/반복 지적"에 반영)\n${ctx.previousSummary.trim()}\n`
    : '';
  return `당신은 골프 레슨 기록을 정리하는 조수입니다. 아래는 휴대폰으로 녹음한 레슨(학생: ${student})을 자동 받아쓰기한 결과입니다.

## 받아쓰기의 특성 (읽기 전에 알아 둘 것)
- 각 줄 앞 [mm:ss] 는 레슨 시작 후 시각입니다.
- **화자 표시가 없습니다.** 코치가 말의 대부분을 하고, 학생은 주로 짧은 질문·대답·감탄을 합니다.
  존댓말로 지시·설명하는 긴 문장은 코치, "~되나?", "~해야 되나?" 같은 짧은 혼잣말·질문은 학생일 가능성이 높습니다.
  확신이 없으면 학생 발화로 넣지 마세요.
- 자동 받아쓰기라 골프 용어가 비슷한 소리로 잘못 적혀 있을 수 있습니다. 문맥으로 바로잡으세요.
  예: 타톱→탑볼, 샌크/쌩크→생크, 멘탈로 끌어→맨팔로 끌어(팔로만 끌어내림), 페이서→페이스, 웨ッジ→웨지.
- 혼자 공을 치는 동안 코치가 부르는 짧은 숫자("20", "30", "70")는 **목표 거리(m)** 입니다.
- 클럽 구경, 예약, 날씨 같은 잡담은 요약에서 빼되, 학생 장비 정보(새 클럽 등)는 학생 요약에 한 줄로 남겨도 됩니다.
${previous}
## 출력 형식 (마크다운, 아래 제목 그대로)

### 오늘의 흐름
한 줄: "A → B → C" 형식으로 연습한 주제 순서.

### 코치 요약
연습 주제를 **4~6개**로 묶어 소제목(시각 범위 포함, 예: "#### 1. 어프로치 거리감 (00:00–21:00)")을 달고, 그 아래 불릿으로:
- 문제점 — **원인** — **교정 방법·드릴** — 제시한 수치·기준 (근거 시각)
- 같은 지적이 여러 번 나오면 한 불릿으로 묶고, 레슨 중 좋아졌는지 덧붙이세요.
- 주제당 불릿 2~5개.

### 좋아진 점
코치가 칭찬하거나 "좋아졌다"고 한 변화 2~4개 (근거 시각).

### 숙제
코치가 **연습하라고 한 것**만, 가장 강조된 순서로 3개. 각 항목은 학생이 혼자 할 수 있는 구체적 행동으로.
다음 레슨에서 하기로 한 것은 숙제가 아니라 "다음 레슨"에 넣으세요.

### 다음 레슨
코치가 다음 시간에 하자고 한 것. 없으면 "언급 없음".

### 학생 요약
학생이 한 질문·느낌·어려움·상황. 근거가 확실한 것만, 없으면 "확인된 학생 발화 없음".

## 규칙
- 받아쓰기에 없는 내용은 절대 만들지 마세요. 코치 요약의 모든 불릿에 근거 시각이 있어야 합니다.
- 수치(거리, 클럽 번호, 각도)는 받아쓰기 그대로.
- 출력하기 전에 받아쓰기를 처음부터 끝까지 다시 훑어, **빠뜨린 교정 포인트·드릴·클럽 선택 조언·코스 공략 조언**이 있으면 해당 주제에 추가하세요.
- 머리말·맺음말 없이 위 형식만 출력하세요.

## 받아쓰기
${renderTranscript(segments)}
`;
}

/** 모델이 형식 밖 머리말을 붙여도 "### 오늘의 흐름"부터 잘라 쓴다. */
export function cleanSummary(text: string): string {
  const t = text.trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/, '').trim();
  const i = t.indexOf('### 오늘의 흐름');
  return i > 0 ? t.slice(i) : t;
}

export const LESSON_RECORDING_SUMMARY_FEATURE = 'lesson_recording_summary';

export function geminiSummarizer(): Summarizer {
  return {
    name: 'gemini',
    async summarize(prompt) {
      const model = resolveModel(LESSON_RECORDING_SUMMARY_FEATURE);
      try {
        return await invokeGeminiApi({ operation: LESSON_RECORDING_SUMMARY_FEATURE, prompt, model, temperature: 0.2 });
      } catch (err) {
        // 라우팅된 프리뷰 모델이 은퇴(404)했거나 한도(429)면 기본 모델로 한 번 더.
        if (!isModelFallbackError(err)) throw err;
        return invokeGeminiApi({
          operation: LESSON_RECORDING_SUMMARY_FEATURE,
          prompt,
          model: getDefaultModel(),
          temperature: 0.2,
        });
      }
    },
  };
}
