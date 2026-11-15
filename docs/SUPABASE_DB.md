# DB: Supabase Postgres

2026-11-15부터 CoachXai 서버의 DB는 Render Postgres가 아니라 **Supabase Postgres**다.
Express 서버(API·로그인·결제 웹훅·R2·푸시·AI)는 그대로 Render에서 돈다. 바뀐 것은 `DATABASE_URL` 하나다.

| 항목 | 값 |
|---|---|
| Supabase 프로젝트 | `coachxai` (id `hjbgdgwupbmcbqjtufzj`, ap-northeast-2 서울) |
| 스키마 | `server/migrations/` 0001–0013 적용 완료 (`pgmigrations` 13행) |
| 공개 API | 막음 — 아래 "보안" 참고 |
| 옮긴 데이터 | 없음 (새로 시작) |

## Render에 연결하기 (한 번만)

1. Supabase 대시보드 → 프로젝트 → **Connect** → **Session pooler** 연결 문자열을 복사한다.
   ```
   postgresql://postgres.hjbgdgwupbmcbqjtufzj:[YOUR-PASSWORD]@aws-<n>-ap-northeast-2.pooler.supabase.com:5432/postgres
   ```
   - `[YOUR-PASSWORD]`는 DB 비밀번호(Project Settings → Database에서 재설정 가능).
   - **Direct connection(`db.<ref>.supabase.co`)은 쓰지 않는다** — IPv6 전용이라 Render에서 닿지 않는다.
   - **Transaction pooler(:6543)도 쓰지 않는다** — 서버 시작 시 마이그레이션이 잡는 잠금이 세션을 유지해야 한다.
2. Render → `coachxai-server` → Environment → `DATABASE_URL`을 위 문자열로 바꾸고 저장 → 재배포.
3. 로그에 `[migrate] No migrations to run!`이 나오고 `/api/health`가 응답하면 끝.
4. 잘 돌면 Render의 `coachxai-db`(Postgres)는 삭제해도 된다. `render.yaml`에서는 이미 뺐지만 블루프린트에서 빠져도 Render가 자동으로 지우지는 않으므로, 요금을 멈추려면 대시보드에서 직접 지운다.

## 보안: 공개 API 막기

Supabase는 `public` 스키마의 모든 표를 Data API(`https://<ref>.supabase.co/rest/v1`)로 `anon`·`authenticated` 역할에 내보낸다.
이 앱은 그 API를 쓰지 않는다(모든 접근은 Express 서버가 표 소유자로 한다). 그대로 두면 `coaches.password_hash`, 전화번호,
레슨 기록, 결제 내역이 공개 키 하나로 읽힐 수 있으므로 막아 두었다.

- 모든 표에 RLS를 켜고 정책은 두지 않는다 → Data API로는 아무 행도 안 보인다.
- `anon`·`authenticated`의 표·시퀀스 권한을 회수하고, 앞으로 만들어질 표에도 주지 않도록 기본 권한을 바꿨다.
- 서버는 시작할 때마다(마이그레이션 직후) `lockDownSupabaseDataApi()`(`server/src/services/db.ts`)로 같은 처리를 다시 한다.
  새 마이그레이션이 표를 추가해도 자동으로 막힌다. `anon` 역할이 없는 로컬 Postgres에서는 아무것도 하지 않는다.
- Supabase 보안 점검(Advisors)의 "RLS Enabled No Policy" 안내 36건은 이 의도된 상태다.

서버는 표 소유자(`postgres`)로 접속하므로 RLS의 영향을 받지 않는다.

## 환경 변수

| 이름 | 설명 |
|---|---|
| `DATABASE_URL` | Session pooler 연결 문자열 (필수) |
| `PG_POOL_MAX` | 서버 커넥션 풀 크기, 기본 10. Session pooler는 사용자당 동시 연결 수 제한이 있다(가장 작은 컴퓨트 15) |
| `DATABASE_SSL` | `false`면 TLS 없이 접속(로컬 Postgres 개발용). `true`면 개발 환경에서도 TLS. 운영(`NODE_ENV=production`)은 기본 TLS |

## 백업

`.github/workflows/db-backup.yml`이 매주 `public` 스키마를 `pg_dump`해 R2에 올린다.
GitHub 저장소 Secrets에 `SUPABASE_DATABASE_URL`(Session pooler 문자열)을 등록한다. 예전 `RENDER_DATABASE_URL`도 대체값으로 읽는다.
Supabase 무료 플랜에는 자동 백업이 없으므로 이 작업을 켜 두는 것이 좋다.

## 알아 둘 것

- **지역:** DB는 서울에 있다. Render 서버도 가까운 지역(Singapore)에 두면 쿼리 왕복 지연이 줄어든다
  (Render에는 서울 지역이 없다). 처음 만든 싱가포르 프로젝트 `kingsamuel8's Project`(`zmujcnbqoxursadvkopq`)는
  빈 스키마만 있던 상태로 일시정지했다. 쓰지 않으므로 삭제해도 된다.
- **무료 플랜 일시정지:** Supabase 무료 프로젝트는 7일간 활동이 없으면 일시정지된다. 서버가 계속 쿼리하면 문제없지만,
  출시 후에는 Pro 플랜을 권한다.
- **스키마 변경:** 지금처럼 `server/migrations/`에 새 파일을 추가한다. 서버 시작 시 자동 적용된다.

## Supabase 모드 (이전 1단계 — Express 없이 녹음 → 정리 → 전달)

웹 앱 주소에 `?supabase=1`을 붙이면(기기에 기억, `?supabase=0`으로 끔) 단순 코치 화면이 Express 대신
Supabase로 돈다. 빌드 환경 변수 `VITE_BACKEND=supabase`면 항상 켜진다.

| 기능 | Express 모드 | Supabase 모드 |
|---|---|---|
| 코치 로그인 | `/api/auth/login/coach` (자체 JWT) | Supabase Auth (이메일·비밀번호). 가입 시 `user_metadata.role='coach'` → 트리거가 `coaches` 행 생성 |
| 고객·레슨 읽기/저장 | `/api/clients`, `/api/lessons` | 표 직접 접근, RLS로 자기 것만 (마이그레이션 0014) |
| 용어 사전 | `/api/coaches/me/lesson-vocabulary` | `coaches.lesson_vocabulary` 직접 |
| 공유 링크 | `POST /api/lessons/:id/share` (22자 토큰) | `share_lesson()` (64자 토큰) |
| 링크로 노트 열기 | `GET /api/public/lesson-notes/:token` | `get_public_lesson_note()` — 토큰 모양으로 자동 선택 |
| AI | `POST /api/ai/invoke` | Edge Function `ai-invoke` (`supabase/functions/ai-invoke`) |

- AI 모델·온도는 `supabase/functions/_shared/aiRouting.ts`와 Express(`modelRouter.ts`, `aiTemperature.ts`)가 같아야 한다.
  `__tests__/aiRoutingParity.test.ts`가 확인한다.
- Edge Function 비밀값: `GEMINI_API_KEY`(필수), `GEMINI_MODEL`·`AI_RATE_LIMIT_PER_MIN`(선택). Supabase 대시보드 →
  Edge Functions → Secrets.
- 스트리밍(코치 AI 채팅)은 아직 없다. Supabase 모드에서는 비스트리밍 호출로 넘어간다.
- 웹 앱의 Supabase 주소·publishable 키는 `utils/supabaseMode.ts`에 기본값이 있고 `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_PUBLISHABLE_KEY`로 바꿀 수 있다(공개 값).
