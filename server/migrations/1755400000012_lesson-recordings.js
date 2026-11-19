/**
 * 레슨 녹음 v2 (docs/VOICE_RECORDING_PLAN.md §4.3).
 *
 * 녹음은 앱의 네이티브 녹음기가 60초 세그먼트로 잘라 레슨 중에 계속
 * 올린다. 서버는 세그먼트를 R2 에 받아 두고, 종료 선언(complete)이 오고
 * 모든 세그먼트가 모이면 처리(받아쓰기·요약) 대기열에 올린다.
 *
 * 원본 오디오는 기본 3일 후 삭제된다(audio_expires_at). 코치가 보관을
 * 누르면 kept_at 이 서고 자동 삭제에서 빠진다 — 대신 플랜별 보관 시간
 * 한도에 잡힌다. 받아쓰기(transcript_segments)는 원본이 지워져도 남는다.
 *
 * 시각은 기존 테이블과 같이 epoch ms BIGINT.
 */

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS lesson_recordings (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      coach_id          UUID         NOT NULL,
      client_id         VARCHAR(255),
      client_name       VARCHAR(255),
      lesson_id         VARCHAR(255),
      -- recording → uploading(종료 선언, 세그먼트 대기) → queued(처리 대기)
      --   → processing → ready | failed
      status            VARCHAR(20)  NOT NULL DEFAULT 'recording',
      mime_type         VARCHAR(50)  NOT NULL DEFAULT 'audio/mp4',
      segment_count     INTEGER,               -- complete 때 앱이 알려 준 총 개수
      duration_ms       BIGINT,
      bytes             BIGINT       NOT NULL DEFAULT 0,
      started_at        BIGINT       NOT NULL,
      ended_at          BIGINT,
      audio_expires_at  BIGINT,                -- ended_at + 3일. 보관 시 NULL
      kept_at           BIGINT,
      audio_deleted_at  BIGINT,
      stt_engine        VARCHAR(50),
      error             TEXT,
      created_at        BIGINT       NOT NULL,
      updated_at        BIGINT       NOT NULL
    )
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_lesson_recordings_coach
      ON lesson_recordings (coach_id, started_at DESC)
  `);
  // 보관 정리 러너가 매시간 훑는 대상만 담는 부분 인덱스.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_lesson_recordings_expiring
      ON lesson_recordings (audio_expires_at)
      WHERE kept_at IS NULL AND audio_deleted_at IS NULL
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_lesson_recordings_queued
      ON lesson_recordings (updated_at)
      WHERE status = 'queued'
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS recording_segments (
      recording_id  UUID    NOT NULL REFERENCES lesson_recordings(id) ON DELETE CASCADE,
      seq           INTEGER NOT NULL,
      r2_key        TEXT    NOT NULL,
      bytes         INTEGER NOT NULL,
      duration_ms   INTEGER,
      uploaded_at   BIGINT  NOT NULL,
      PRIMARY KEY (recording_id, seq)
    )
  `);

  // 전화 수신 등으로 녹음이 끊긴 구간. 받아쓰기 타임라인에 표시한다.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS recording_gaps (
      recording_id  UUID        NOT NULL REFERENCES lesson_recordings(id) ON DELETE CASCADE,
      start_ms      BIGINT      NOT NULL,
      end_ms        BIGINT,
      reason        VARCHAR(50) NOT NULL,
      PRIMARY KEY (recording_id, start_ms)
    )
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS transcript_segments (
      recording_id    UUID        NOT NULL REFERENCES lesson_recordings(id) ON DELETE CASCADE,
      idx             INTEGER     NOT NULL,
      start_ms        BIGINT      NOT NULL,
      end_ms          BIGINT      NOT NULL,
      speaker         VARCHAR(20) NOT NULL DEFAULT 'unknown',
      raw_text        TEXT        NOT NULL,   -- 엔진 원문, 절대 덮어쓰지 않는다
      text            TEXT        NOT NULL,   -- 교정 후(코치 수정 포함)
      confidence      REAL,
      edited_by_coach BOOLEAN     NOT NULL DEFAULT false,
      PRIMARY KEY (recording_id, idx)
    )
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS transcript_segments`);
  pgm.sql(`DROP TABLE IF EXISTS recording_gaps`);
  pgm.sql(`DROP TABLE IF EXISTS recording_segments`);
  pgm.sql(`DROP TABLE IF EXISTS lesson_recordings`);
};
