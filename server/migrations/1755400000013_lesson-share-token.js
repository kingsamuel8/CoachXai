/**
 * 레슨 노트 공유 링크.
 *
 * 서비스의 핵심은 "녹음 → 정리 → 고객에게 전달"이다. 고객이 앱을 깔고
 * 가입하지 않아도 코치가 보낸 링크 하나로 오늘의 레슨 노트를 볼 수 있어야
 * 한다(카카오톡·WhatsApp·문자로 전달). 그래서 레슨마다 추측할 수 없는
 * 공유 토큰을 하나 둔다. 토큰을 아는 사람만 그 레슨의 "고객용 노트"를
 * 읽을 수 있고, 필기 전문·코치 메모 같은 나머지 기록은 링크로 나가지 않는다.
 */

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql('ALTER TABLE lessons ADD COLUMN IF NOT EXISTS share_token VARCHAR(64)');
  pgm.sql('ALTER TABLE lessons ADD COLUMN IF NOT EXISTS share_created_at BIGINT');
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_share_token
      ON lessons (share_token)
      WHERE share_token IS NOT NULL
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_lessons_share_token`);
  pgm.sql(`ALTER TABLE lessons DROP COLUMN IF EXISTS share_token, DROP COLUMN IF EXISTS share_created_at`);
};
