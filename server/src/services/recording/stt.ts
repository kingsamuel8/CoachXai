/**
 * 받아쓰기 엔진 — 지금은 ElevenLabs Scribe v2.
 *
 * PoC(2026-11-19, 65분 실제 레슨)에서 Google Chirp 3 대비 중복·순서 뒤섞임이
 * 없고 골프 용어 표기가 정확했으며, 한 번에 21초로 처리됐다.
 * (scripts/stt-poc/run_stt.py, docs/VOICE_RECORDING_PLAN.md §6)
 */
import { readFile } from 'fs/promises';
import path from 'path';

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  speaker: string | null;
  text: string;
}

export interface SttResult {
  engine: string;
  segments: TranscriptSegment[];
}

export interface SttEngine {
  name: string;
  transcribe(file: string, opts: { keyterms: string[] }): Promise<SttResult>;
}

/** 받아쓰기 정확도를 올리는 골프 용어 힌트(최대 100개). */
export const GOLF_KEYTERMS = [
  '어드레스', '그립', '그립 압력', '스탠스', '테이크어웨이', '백스윙', '백스윙 탑', '코킹',
  '다운스윙', '하체 리드', '체중 이동', '임팩트', '페이스', '릴리스', '팔로스루', '피니시',
  '스웨이', '헤드업', '얼리 익스텐션', '슬라이스', '훅', '드로우', '페이드', '인투아웃', '아웃투인',
  '뒤땅', '탑볼', '생크', '하프 스윙', '펀치샷', '어프로치', '피칭 웨지', '샌드 웨지', '하이브리드',
  '드라이버', '우드', '아이언', '퍼터', '퍼팅', '숏게임', '스퀘어', '로테이션', '몸통 턴',
];

interface ElevenLabsWord {
  text?: string;
  start?: number;
  end?: number;
  type?: string;
  speaker_id?: string;
}

/** 단어 단위 응답을 같은 화자·가까운 단어끼리 이어 구간으로 만든다. */
export function wordsToSegments(words: ElevenLabsWord[], gapMs = 1500): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  for (const w of words) {
    if (w.type && w.type !== 'word') continue;
    const text = (w.text ?? '').trim();
    if (!text) continue;
    const startMs = Math.round(Number(w.start ?? 0) * 1000);
    const endMs = Math.round(Number(w.end ?? 0) * 1000);
    const speaker = w.speaker_id ?? null;
    const last = segs[segs.length - 1];
    if (last && last.speaker === speaker && startMs - last.endMs >= 0 && startMs - last.endMs < gapMs) {
      last.endMs = Math.max(last.endMs, endMs);
      last.text += ` ${text}`;
    } else {
      segs.push({ startMs, endMs, speaker, text });
    }
  }
  return segs;
}

export function elevenLabsEngine(apiKey = process.env.ELEVENLABS_API_KEY ?? ''): SttEngine {
  return {
    name: 'elevenlabs:scribe_v2',
    async transcribe(file, { keyterms }) {
      if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not configured');
      const form = new FormData();
      form.append('file', new Blob([await readFile(file)], { type: 'audio/mp4' }), path.basename(file));
      form.append('model_id', 'scribe_v2');
      form.append('language_code', 'kor');
      form.append('diarize', 'true');
      form.append('tag_audio_events', 'false');
      form.append('timestamps_granularity', 'word');
      for (const t of keyterms.slice(0, 100)) form.append('keyterms', t);

      const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': apiKey },
        body: form,
      });
      const body = await res.text();
      if (!res.ok) throw new SttError(`ElevenLabs HTTP ${res.status}: ${body.slice(0, 300)}`, res.status);
      const data = JSON.parse(body) as { words?: ElevenLabsWord[] };
      return { engine: 'elevenlabs:scribe_v2', segments: wordsToSegments(data.words ?? []) };
    },
  };
}

export class SttError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'SttError';
  }
}
