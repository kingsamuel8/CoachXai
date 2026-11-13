/**
 * 테스트 모드의 레슨 저장소 — 서버 대신 이 기기의 localStorage 에 둔다.
 *
 * localStorage 는 보통 5MB 남짓이라 긴 필기가 쌓이면 넘친다. 넘치면 오래된
 * 레슨부터 필기 전문을 비워 자리를 만든다 — 보낸 노트(고객용 노트)는 남긴다.
 */
import type { Lesson } from '../types';

const STORE_KEY = 'coachxai_test_lessons';

export const listTestLessons = (): Lesson[] => {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as Lesson[]) : [];
  } catch {
    return [];
  }
};

const newId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** 필기 전문을 비운 사본 — 자리가 모자랄 때 오래된 레슨에 쓴다. */
const withoutTranscript = (l: Lesson): Lesson =>
  l.liveLessonDetail ? { ...l, liveLessonDetail: { ...l.liveLessonDetail, transcript: [] } } : l;

export const saveTestLesson = (lesson: Lesson): Lesson => {
  const saved: Lesson = {
    ...lesson,
    id: lesson.id || newId(),
    createdAt: lesson.createdAt || Date.now(),
  };
  let all = [saved, ...listTestLessons().filter((l) => l.id !== saved.id)];
  for (let trimmed = all.length; ; trimmed--) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(all));
      return saved;
    } catch {
      // 자리가 없다 — 가장 오래된 레슨부터 필기를 비운다. 다 비워도 안 되면 포기.
      if (trimmed <= 1) throw new Error('테스트 저장 공간이 가득 찼어요. 오래된 테스트 레슨을 지워 주세요.');
      all = all.map((l, i) => (i >= trimmed - 1 ? withoutTranscript(l) : l));
    }
  }
};

export const clearTestLessons = (): void => {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // 무시
  }
};
