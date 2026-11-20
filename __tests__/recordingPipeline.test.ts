import { describe, it, expect } from 'vitest';
import { wordsToSegments, GOLF_KEYTERMS } from '../server/src/services/recording/stt';
import { concatList } from '../server/src/services/recording/audio';
import {
  buildSummaryPrompt,
  cleanSummary,
  renderTranscript,
} from '../server/src/services/recording/summary';
import { retryDelayMs } from '../server/src/services/recording/processor';

describe('wordsToSegments — ElevenLabs 단어 → 구간', () => {
  it('같은 화자의 가까운 단어를 한 구간으로 잇고, 공백·이벤트 토큰은 버린다', () => {
    const segs = wordsToSegments([
      { text: '팔로스루가', start: 1.0, end: 1.5, type: 'word', speaker_id: 's0' },
      { text: ' ', start: 1.5, end: 1.6, type: 'spacing', speaker_id: 's0' },
      { text: '짧아요', start: 1.6, end: 2.0, type: 'word', speaker_id: 's0' },
      { text: '(타구음)', start: 2.1, end: 2.2, type: 'audio_event' },
      { text: '네', start: 2.3, end: 2.5, type: 'word', speaker_id: 's1' },
      { text: '대칭으로', start: 9.0, end: 9.5, type: 'word', speaker_id: 's1' },
    ]);
    expect(segs).toEqual([
      { startMs: 1000, endMs: 2000, speaker: 's0', text: '팔로스루가 짧아요' },
      { startMs: 2300, endMs: 2500, speaker: 's1', text: '네' },
      { startMs: 9000, endMs: 9500, speaker: 's1', text: '대칭으로' },
    ]);
  });

  it('시간이 거꾸로 가는 단어는 앞 구간에 붙이지 않는다', () => {
    const segs = wordsToSegments([
      { text: '하나', start: 10, end: 10.5, type: 'word', speaker_id: 's0' },
      { text: '둘', start: 3, end: 3.5, type: 'word', speaker_id: 's0' },
    ]);
    expect(segs).toHaveLength(2);
  });

  it('용어 힌트는 API 한도(100개) 안이다', () => {
    expect(GOLF_KEYTERMS.length).toBeLessThanOrEqual(100);
  });
});

describe('concatList', () => {
  it('ffmpeg concat 목록을 만들고 작은따옴표를 이스케이프한다', () => {
    expect(concatList(['/a/seg-0000.m4a', "/b/it's.m4a"])).toBe(
      "file '/a/seg-0000.m4a'\nfile '/b/it'\\''s.m4a'\n"
    );
  });
});

describe('요약 프롬프트 v3', () => {
  const segs = [
    { startMs: 9_000, endMs: 12_000, speaker: null, text: '팔로스루가 너무 짧으셔서 그래요.' },
    { startMs: 64_000, endMs: 66_000, speaker: null, text: '겨드랑이 붙이고 돌아요.' },
  ];

  it('받아쓰기를 [mm:ss] 줄로 싣는다', () => {
    expect(renderTranscript(segs)).toBe('[00:09] 팔로스루가 너무 짧으셔서 그래요.\n[01:04] 겨드랑이 붙이고 돌아요.');
  });

  it('학생 이름·형식·창작 금지·숙제 규칙을 담는다', () => {
    const p = buildSummaryPrompt(segs, { studentName: '홍길동' });
    expect(p).toContain('학생: 홍길동');
    expect(p).toContain('### 숙제');
    expect(p).toContain('4~6개');
    expect(p).toContain('받아쓰기에 없는 내용은 절대 만들지 마세요');
    expect(p).toContain('다음 레슨에서 하기로 한 것은 숙제가 아니라');
    expect(p).toContain('[01:04] 겨드랑이 붙이고 돌아요.');
    expect(p).not.toContain('지난 레슨 요약');
  });

  it('지난 레슨 요약이 있으면 비교용으로 넣는다', () => {
    const p = buildSummaryPrompt(segs, { previousSummary: '### 숙제\n1. 40m 연습' });
    expect(p).toContain('## 지난 레슨 요약');
    expect(p).toContain('1. 40m 연습');
  });

  it('모델이 붙인 머리말과 코드 펜스를 떼어 낸다', () => {
    expect(cleanSummary('```markdown\n요약입니다:\n### 오늘의 흐름\nA → B\n```')).toBe('### 오늘의 흐름\nA → B');
    expect(cleanSummary('### 오늘의 흐름\nA')).toBe('### 오늘의 흐름\nA');
  });
});

describe('재시도 간격', () => {
  it('2, 4, 8분', () => {
    expect([1, 2, 3].map(retryDelayMs)).toEqual([120_000, 240_000, 480_000]);
  });
});
