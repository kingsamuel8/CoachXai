/**
 * Supabase 이전 1단계 — 코치가 Supabase Auth 로 로그인해 자기 데이터만 쓴다.
 *
 * 서비스의 핵심 흐름(녹음 → 정리 → 전달)을 Express 없이 돌리기 위한 DB 쪽
 * 규칙이다. 앱은 Supabase 클라이언트로 표를 직접 읽고 쓰고, 행 단위 보안(RLS)이
 * "코치는 자기 것만"을 지킨다.
 *
 *  - 가입: auth.users 에 코치가 생기면(user_metadata.role = 'coach') 같은 id 로
 *    coaches 행을 만든다. 그래서 auth.uid() = coaches.id = lessons.coach_id.
 *  - coaches: 자기 행만 읽고, 이름·전화·근무표·용어 사전만 고친다.
 *    비밀번호 해시·구독·포인트는 읽지도 고치지도 못한다.
 *  - clients: coach_id 가 자기인 고객만 읽고 만들고 고친다. 비밀번호 해시·포인트·
 *    구독은 손댈 수 없다.
 *  - lessons: 자기 레슨만 읽고 쓰고 지운다. 공유 토큰·소유권 열은 직접 못 고친다
 *    (공유는 share_lesson() 함수로만).
 *  - share_lesson(id): 자기 레슨에 추측할 수 없는 공유 토큰을 만든다.
 *  - get_public_lesson_note(token): 로그인 없이 고객용 노트만 돌려준다
 *    (Express GET /api/public/lesson-notes/:token 과 같은 모양).
 *
 * Express 서버는 표 소유자로 접속하므로 이 규칙의 영향을 받지 않는다 — 1단계
 * 동안 Express 와 Supabase 가 같은 DB 를 함께 쓴다.
 *
 * auth 스키마가 없는 Postgres(로컬 개발·테스트)에서는 아무것도 하지 않는다.
 */

const SUPABASE_SQL = `
-- 표 전체 권한부터 걷는다. Supabase 는 public 표에 anon/authenticated 전체
-- 권한을 기본으로 주므로, 그대로 두면 아래의 열 단위 권한이 소용없다
-- (예: 코치가 자기 current_points 를 고칠 수 있다).
REVOKE ALL ON public.coaches, public.clients, public.lessons FROM anon, authenticated;

-- 가입하면 코치 행을 같은 id 로 만든다 ------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_coach()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
BEGIN
  IF coalesce(NEW.raw_user_meta_data ->> 'role', '') = 'coach' THEN
    INSERT INTO public.coaches (id, name, email, created_at, updated_at)
    VALUES (
      NEW.id,
      coalesce(nullif(trim(NEW.raw_user_meta_data ->> 'name'), ''), split_part(NEW.email, '@', 1)),
      NEW.email,
      now_ms,
      now_ms
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.handle_new_coach() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created_coach ON auth.users;
CREATE TRIGGER on_auth_user_created_coach
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_coach();

-- coaches: 자기 행만 --------------------------------------------------------
GRANT SELECT (id, name, email, phone, is_subscribed, subscription_plan, subscription_end_date,
              current_points, working_schedule, lesson_vocabulary, created_at, updated_at)
  ON public.coaches TO authenticated;
GRANT UPDATE (name, phone, working_schedule, lesson_vocabulary, updated_at)
  ON public.coaches TO authenticated;

DROP POLICY IF EXISTS coaches_select_own ON public.coaches;
CREATE POLICY coaches_select_own ON public.coaches
  FOR SELECT TO authenticated USING (id = (select auth.uid()));
DROP POLICY IF EXISTS coaches_update_own ON public.coaches;
CREATE POLICY coaches_update_own ON public.coaches
  FOR UPDATE TO authenticated
  USING (id = (select auth.uid())) WITH CHECK (id = (select auth.uid()));

-- clients: 자기 고객만 ------------------------------------------------------
GRANT SELECT (id, name, phone, email, coach_id, designated_coach, memo, coach_memo,
              created_at, updated_at)
  ON public.clients TO authenticated;
GRANT INSERT (id, name, phone, email, coach_id, designated_coach, memo, coach_memo,
              created_at, updated_at)
  ON public.clients TO authenticated;
GRANT UPDATE (name, phone, email, designated_coach, memo, coach_memo, updated_at)
  ON public.clients TO authenticated;

DROP POLICY IF EXISTS clients_select_own ON public.clients;
CREATE POLICY clients_select_own ON public.clients
  FOR SELECT TO authenticated USING (coach_id = (select auth.uid()));
DROP POLICY IF EXISTS clients_insert_own ON public.clients;
CREATE POLICY clients_insert_own ON public.clients
  FOR INSERT TO authenticated WITH CHECK (coach_id = (select auth.uid()));
DROP POLICY IF EXISTS clients_update_own ON public.clients;
CREATE POLICY clients_update_own ON public.clients
  FOR UPDATE TO authenticated
  USING (coach_id = (select auth.uid())) WITH CHECK (coach_id = (select auth.uid()));

CREATE INDEX IF NOT EXISTS idx_clients_coach ON public.clients (coach_id);

-- lessons: 자기 레슨만 ------------------------------------------------------
GRANT SELECT ON public.lessons TO authenticated;
GRANT INSERT (id, client_id, client_name, client_phone, coach_id, title, date, video_url, video_key,
              media_type, coach_notes, ai_analysis, scorecard, member_body_analysis,
              assigned_homework, media, lesson_package_id, session_number, created_by,
              record_type, club, target_distance, score, scorecard_detail, swing_angle,
              additional_media, thumbnail_url, tags, golf_data, swing_sequence, share_option,
              client_feedback, feedback_status, edited_video_url, video_edit_metadata,
              compare_video_url, compare_video_metadata, created_at, updated_at, visibility,
              approval_status, approved_at, shared_to_student, review_sections,
              live_lesson_detail, review_sections_draft, review_draft_at, review_draft_source)
  ON public.lessons TO authenticated;
GRANT UPDATE (client_id, client_name, client_phone, title, date, video_url, video_key,
              media_type, coach_notes, ai_analysis, scorecard, member_body_analysis,
              assigned_homework, media, lesson_package_id, session_number, created_by,
              record_type, club, target_distance, score, scorecard_detail, swing_angle,
              additional_media, thumbnail_url, tags, golf_data, swing_sequence, share_option,
              client_feedback, feedback_status, edited_video_url, video_edit_metadata,
              compare_video_url, compare_video_metadata, updated_at, visibility,
              approval_status, approved_at, shared_to_student, review_sections,
              live_lesson_detail, review_sections_draft, review_draft_at, review_draft_source)
  ON public.lessons TO authenticated;
GRANT DELETE ON public.lessons TO authenticated;

DROP POLICY IF EXISTS lessons_select_own ON public.lessons;
CREATE POLICY lessons_select_own ON public.lessons
  FOR SELECT TO authenticated USING (coach_id = (select auth.uid()));
DROP POLICY IF EXISTS lessons_insert_own ON public.lessons;
CREATE POLICY lessons_insert_own ON public.lessons
  FOR INSERT TO authenticated WITH CHECK (coach_id = (select auth.uid()));
DROP POLICY IF EXISTS lessons_update_own ON public.lessons;
CREATE POLICY lessons_update_own ON public.lessons
  FOR UPDATE TO authenticated
  USING (coach_id = (select auth.uid())) WITH CHECK (coach_id = (select auth.uid()));
DROP POLICY IF EXISTS lessons_delete_own ON public.lessons;
CREATE POLICY lessons_delete_own ON public.lessons
  FOR DELETE TO authenticated USING (coach_id = (select auth.uid()));

CREATE INDEX IF NOT EXISTS idx_lessons_coach ON public.lessons (coach_id, created_at DESC);

-- 공유 토큰 만들기: 자기 레슨에만, 추측할 수 없는 값으로 ---------------------
CREATE OR REPLACE FUNCTION public.share_lesson(p_lesson_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_token text;
BEGIN
  IF (select auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501';
  END IF;
  SELECT share_token INTO v_token
    FROM public.lessons
   WHERE id = p_lesson_id AND coach_id = (select auth.uid());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lesson not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_token IS NULL THEN
    -- 두 UUID 의 무작위 부분 = 244비트. 링크용 문자([0-9a-f])만 쓴다.
    v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    UPDATE public.lessons
       SET share_token = v_token,
           share_created_at = (extract(epoch from now()) * 1000)::bigint
     WHERE id = p_lesson_id AND share_token IS NULL;
    -- 동시에 두 번 눌렸으면 먼저 저장된 토큰을 쓴다.
    SELECT share_token INTO v_token FROM public.lessons WHERE id = p_lesson_id;
  END IF;
  RETURN v_token;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.share_lesson(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.share_lesson(uuid) TO authenticated;

-- 링크로 고객이 여는 노트: 고객용 노트만 -------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_lesson_note(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  r record;
  detail jsonb;
  note jsonb;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{16,64}$' THEN
    RETURN NULL;
  END IF;
  SELECT l.client_name, l.date, l.live_lesson_detail, c.name AS coach_name
    INTO r
    FROM public.lessons l
    LEFT JOIN public.coaches c ON c.id = l.coach_id
   WHERE l.share_token = p_token;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  detail := coalesce(r.live_lesson_detail, '{}'::jsonb);
  note := CASE WHEN jsonb_typeof(detail -> 'clientNote') = 'object' THEN detail -> 'clientNote' END;
  RETURN jsonb_build_object(
    'coachName', coalesce(r.coach_name, ''),
    'studentName', coalesce(r.client_name, ''),
    'date', coalesce(r.date, ''),
    'note', CASE WHEN note IS NULL THEN NULL ELSE jsonb_build_object(
      'language', coalesce(note ->> 'language', ''),
      'headline', coalesce(note ->> 'headline', ''),
      'keyPoints', CASE WHEN jsonb_typeof(note -> 'keyPoints') = 'array'
                        THEN (SELECT coalesce(jsonb_agg(x), '[]'::jsonb)
                                FROM jsonb_array_elements(note -> 'keyPoints') x
                               WHERE jsonb_typeof(x) = 'string' AND btrim(x #>> '{}') <> '')
                        ELSE '[]'::jsonb END,
      'drills', CASE WHEN jsonb_typeof(note -> 'drills') = 'array'
                     THEN (SELECT coalesce(jsonb_agg(x), '[]'::jsonb)
                             FROM jsonb_array_elements(note -> 'drills') x
                            WHERE jsonb_typeof(x) = 'string' AND btrim(x #>> '{}') <> '')
                     ELSE '[]'::jsonb END,
      'nextFocus', coalesce(note ->> 'nextFocus', ''),
      'message', coalesce(note ->> 'message', '')
    ) END,
    'fallbackSummary', CASE WHEN note IS NULL
                            THEN coalesce(nullif(detail ->> 'coachSummary', ''), detail ->> 'summary', '')
                            ELSE '' END
  );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.get_public_lesson_note(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_lesson_note(text) TO anon, authenticated;
`;

exports.shorthands = undefined;
exports.SUPABASE_SQL = SUPABASE_SQL;

const isSupabase = async (pgm) => {
  const rows = await pgm.db.select(
    `SELECT 1 FROM pg_namespace WHERE nspname = 'auth'
      AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')`
  );
  return rows.length > 0;
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = async (pgm) => {
  if (!(await isSupabase(pgm))) return;
  pgm.sql(SUPABASE_SQL);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = async (pgm) => {
  if (!(await isSupabase(pgm))) return;
  pgm.sql(`
    DROP TRIGGER IF EXISTS on_auth_user_created_coach ON auth.users;
    DROP FUNCTION IF EXISTS public.handle_new_coach();
    DROP FUNCTION IF EXISTS public.share_lesson(uuid);
    DROP FUNCTION IF EXISTS public.get_public_lesson_note(text);
    DROP POLICY IF EXISTS coaches_select_own ON public.coaches;
    DROP POLICY IF EXISTS coaches_update_own ON public.coaches;
    DROP POLICY IF EXISTS clients_select_own ON public.clients;
    DROP POLICY IF EXISTS clients_insert_own ON public.clients;
    DROP POLICY IF EXISTS clients_update_own ON public.clients;
    DROP POLICY IF EXISTS lessons_select_own ON public.lessons;
    DROP POLICY IF EXISTS lessons_insert_own ON public.lessons;
    DROP POLICY IF EXISTS lessons_update_own ON public.lessons;
    DROP POLICY IF EXISTS lessons_delete_own ON public.lessons;
    REVOKE ALL ON public.coaches, public.clients, public.lessons FROM authenticated;
  `);
};
