/**
 * 레슨 녹음 v2 — 처리(받아쓰기 → 요약) 결과와 재시도 상태.
 * (docs/VOICE_RECORDING_PLAN.md §4.2, §11.5)
 *
 * 받아쓰기 원문은 transcript_segments 에, 요약 본문(마크다운)은 여기
 * summary_md 에 둔다. 원본 오디오가 3일 뒤 지워져도 둘 다 남는다.
 */

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE lesson_recordings
      ADD COLUMN IF NOT EXISTS summary_md        TEXT,
      ADD COLUMN IF NOT EXISTS summary_model     VARCHAR(80),
      ADD COLUMN IF NOT EXISTS transcript_engine VARCHAR(80),
      ADD COLUMN IF NOT EXISTS processed_at      BIGINT,
      ADD COLUMN IF NOT EXISTS attempts          INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS next_attempt_at   BIGINT
  `);
  // 처리 러너가 매번 훑는 대상: 대기 중이거나, 처리 중에 서버가 죽어 멈춘 녹음.
  pgm.sql(`DROP INDEX IF EXISTS idx_lesson_recordings_queued`);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_lesson_recordings_pending
      ON lesson_recordings (COALESCE(next_attempt_at, 0))
      WHERE status IN ('queued', 'processing')
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_lesson_recordings_pending`);
  pgm.sql(`
    ALTER TABLE lesson_recordings
      DROP COLUMN IF EXISTS summary_md,
      DROP COLUMN IF EXISTS summary_model,
      DROP COLUMN IF EXISTS transcript_engine,
      DROP COLUMN IF EXISTS processed_at,
      DROP COLUMN IF EXISTS attempts,
      DROP COLUMN IF EXISTS next_attempt_at
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_lesson_recordings_queued
      ON lesson_recordings (updated_at)
      WHERE status = 'queued'
  `);
};
