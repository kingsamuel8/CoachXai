/**
 * Supabase 모드의 코치 데이터 — Express 의 레슨·고객·용어 사전·공유 API 를 대신한다.
 *
 * 표는 RLS 로 "코치 본인 것만" 열려 있다(server/migrations/1755400000014).
 * 열 이름·값 변환은 Express(server/src/routes/lessons.ts mapLesson / POST)와 같게 맞춘다 —
 * 그래야 같은 DB 를 Express 와 함께 쓰는 동안 두 쪽 기록이 섞여도 똑같이 읽힌다.
 */
import type { ClientProfile, Lesson } from '../types';
import type { PublicLessonNote } from './apiService';
import { getSupabase } from './supabaseClient';

/** Lesson 필드 ↔ lessons 열. 왼쪽이 앱, 오른쪽이 DB. */
const LESSON_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['clientId', 'client_id'],
  ['clientName', 'client_name'],
  ['clientPhone', 'client_phone'],
  ['createdBy', 'created_by'],
  ['recordType', 'record_type'],
  ['title', 'title'],
  ['date', 'date'],
  ['club', 'club'],
  ['targetDistance', 'target_distance'],
  ['score', 'score'],
  ['scorecardDetail', 'scorecard_detail'],
  ['videoUrl', 'video_url'],
  ['videoKey', 'video_key'],
  ['mediaType', 'media_type'],
  ['swingAngle', 'swing_angle'],
  ['additionalMedia', 'additional_media'],
  ['thumbnailUrl', 'thumbnail_url'],
  ['coachNotes', 'coach_notes'],
  ['aiAnalysis', 'ai_analysis'],
  ['scorecard', 'scorecard'],
  ['tags', 'tags'],
  ['golfData', 'golf_data'],
  ['swingSequence', 'swing_sequence'],
  ['shareOption', 'share_option'],
  ['clientFeedback', 'client_feedback'],
  ['feedbackStatus', 'feedback_status'],
  ['memberBodyAnalysis', 'member_body_analysis'],
  ['assignedHomework', 'assigned_homework'],
  ['editedVideoUrl', 'edited_video_url'],
  ['videoEditMetadata', 'video_edit_metadata'],
  ['compareVideoUrl', 'compare_video_url'],
  ['compareVideoMetadata', 'compare_video_metadata'],
  ['media', 'media'],
  ['lessonPackageId', 'lesson_package_id'],
  ['sessionNumber', 'session_number'],
  ['liveLessonDetail', 'live_lesson_detail'],
  ['visibility', 'visibility'],
  ['approvalStatus', 'approval_status'],
  ['approvedAt', 'approved_at'],
  ['sharedToStudent', 'shared_to_student'],
  ['reviewSections', 'review_sections'],
  ['reviewSectionsDraft', 'review_sections_draft'],
  ['reviewDraftAt', 'review_draft_at'],
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_VISIBILITY = new Set(['self', 'coach', 'branch']);

/** 앱의 Lesson → 고칠 수 있는 열만(id·coach_id·created_at 제외). */
export const lessonToRow = (lesson: Lesson): Record<string, unknown> => {
  const row: Record<string, unknown> = {};
  const src = lesson as unknown as Record<string, unknown>;
  for (const [field, column] of LESSON_COLUMNS) {
    if (src[field] !== undefined) row[column] = src[field];
  }
  // Express 와 같은 규칙: 고객 키가 없으면 이름_전화번호, 공개 범위는 허용 목록 안에서만.
  if (!row.client_id && lesson.clientName && lesson.clientPhone) {
    row.client_id = `${lesson.clientName.trim()}_${lesson.clientPhone.trim()}`;
  }
  row.visibility =
    typeof row.visibility === 'string' && ALLOWED_VISIBILITY.has(row.visibility) ? row.visibility : 'coach';
  row.updated_at = Date.now();
  return row;
};

export const rowToLesson = (row: Record<string, unknown>): Lesson => {
  const lesson: Record<string, unknown> = {
    id: row.id,
    coachId: row.coach_id,
    ownership: row.ownership ?? 'shared',
    originalCoachId: row.original_coach_id,
    createdAt: Number(row.created_at),
    updatedAt: row.updated_at == null ? undefined : Number(row.updated_at),
  };
  for (const [field, column] of LESSON_COLUMNS) {
    const v = row[column];
    if (v !== null && v !== undefined) lesson[field] = v;
  }
  return lesson as unknown as Lesson;
};

const CLIENT_COLUMNS = 'id, name, phone, email, coach_id, designated_coach, memo, coach_memo, created_at, updated_at';

const rowToClient = (row: Record<string, unknown>): ClientProfile => ({
  id: row.id as string,
  name: (row.name as string) ?? '',
  phone: (row.phone as string) ?? '',
  email: (row.email as string | null) ?? undefined,
  coachId: (row.coach_id as string | null) ?? undefined,
  designatedCoach: (row.designated_coach as string | null) ?? undefined,
  memo: (row.memo as string | null) ?? undefined,
  coachMemo: (row.coach_memo as string | null) ?? undefined,
});

const fail = (what: string, error: { message: string } | null): never => {
  throw new Error(`${what}: ${error?.message ?? 'unknown error'}`);
};

export interface SupabaseCoach {
  id: string;
  name: string;
  email: string;
}

/** 로그인한 사용자의 코치 행. 코치가 아니면(행이 없으면) null. */
export const loadCurrentCoach = async (): Promise<SupabaseCoach | null> => {
  const sb = getSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) return null;
  const { data, error } = await sb.from('coaches').select('id, name, email').eq('id', auth.user.id).maybeSingle();
  if (error) fail('코치 정보를 불러오지 못했습니다', error);
  if (!data) return null;
  return { id: data.id as string, name: (data.name as string) ?? '', email: (data.email as string) ?? '' };
};

export const listMyClients = async (): Promise<ClientProfile[]> => {
  const { data, error } = await getSupabase().from('clients').select(CLIENT_COLUMNS).order('name');
  if (error) fail('고객 목록을 불러오지 못했습니다', error);
  return (data ?? []).map((r) => rowToClient(r as Record<string, unknown>));
};

export const listMyLessons = async (limit = 200): Promise<Lesson[]> => {
  const { data, error } = await getSupabase()
    .from('lessons')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) fail('레슨 기록을 불러오지 못했습니다', error);
  return (data ?? []).map((r) => rowToLesson(r as Record<string, unknown>));
};

/**
 * 레슨을 저장한다. id 가 있으면 고치고, 없거나 아직 없는 레슨이면 새로 만든다.
 * (upsert 를 쓰지 않는 이유: ON CONFLICT DO UPDATE 가 coach_id·created_at 까지
 * 고치려 해, 그 열에 수정 권한이 없는 RLS 규칙과 부딪힌다.)
 */
export const saveMyLesson = async (lesson: Lesson, coachId: string): Promise<Lesson> => {
  const sb = getSupabase();
  const row = lessonToRow(lesson);
  if (lesson.id && UUID.test(lesson.id)) {
    const { data, error } = await sb.from('lessons').update(row).eq('id', lesson.id).select('*');
    if (error) fail('레슨을 저장하지 못했습니다', error);
    if (data && data.length > 0) return rowToLesson(data[0] as Record<string, unknown>);
  }
  const id = lesson.id && UUID.test(lesson.id) ? lesson.id : crypto.randomUUID();
  const { data, error } = await sb
    .from('lessons')
    .insert({ ...row, id, coach_id: coachId, created_at: lesson.createdAt || Date.now() })
    .select('*')
    .single();
  if (error) fail('레슨을 저장하지 못했습니다', error);
  return rowToLesson(data as Record<string, unknown>);
};

/** 자기 레슨의 공유 토큰(없으면 만든다). */
export const shareMyLesson = async (lessonId: string): Promise<string> => {
  const { data, error } = await getSupabase().rpc('share_lesson', { p_lesson_id: lessonId });
  if (error) fail('공유 링크를 만들지 못했습니다', error);
  return data as string;
};

/** 링크로 연 고객용 노트. 없는 토큰이면 status 404 오류를 던진다(PublicLessonNote 계약). */
export const getPublicNote = async (token: string): Promise<PublicLessonNote> => {
  const { data, error } = await getSupabase().rpc('get_public_lesson_note', { p_token: token });
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  if (!data) throw Object.assign(new Error('Not found'), { status: 404 });
  return data as PublicLessonNote;
};

export const loadMyVocabulary = async (): Promise<unknown> => {
  const sb = getSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) throw new Error('not signed in');
  const { data, error } = await sb.from('coaches').select('lesson_vocabulary').eq('id', auth.user.id).single();
  if (error) fail('용어 사전을 불러오지 못했습니다', error);
  return (data as { lesson_vocabulary: unknown }).lesson_vocabulary;
};

export const saveMyVocabulary = async (vocabulary: unknown): Promise<unknown> => {
  const sb = getSupabase();
  const { data: auth } = await sb.auth.getUser();
  if (!auth.user) throw new Error('not signed in');
  const { data, error } = await sb
    .from('coaches')
    .update({ lesson_vocabulary: vocabulary, updated_at: Date.now() })
    .eq('id', auth.user.id)
    .select('lesson_vocabulary')
    .single();
  if (error) fail('용어 사전을 저장하지 못했습니다', error);
  return (data as { lesson_vocabulary: unknown }).lesson_vocabulary;
};
