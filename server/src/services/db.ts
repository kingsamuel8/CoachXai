import path from 'path';
import { Pool } from 'pg';
import runner from 'node-pg-migrate';
import { CURRICULUM_PART_DEFS } from '../seeds/curriculumParts';

// The database is Supabase Postgres (moved off Render Postgres). Connect
// through Supabase's "Session pooler" URL: it is reachable over IPv4 (the
// direct db.<ref>.supabase.co host is IPv6-only) and, unlike the transaction
// pooler on :6543, keeps session state, which node-pg-migrate's advisory lock
// needs. Supabase requires TLS; DATABASE_SSL=false is only for a local
// Postgres in development.
const ssl =
  process.env.DATABASE_SSL === 'false'
    ? undefined
    : process.env.NODE_ENV === 'production' || process.env.DATABASE_SSL === 'true'
      ? { rejectUnauthorized: false }
      : undefined;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  // The session pooler caps clients per user (15 on the smallest Supabase
  // compute); stay under it, leaving room for the migration runner.
  max: Number(process.env.PG_POOL_MAX) || 10,
});

/**
 * Supabase publishes every table in `public` through its Data API
 * (PostgREST at https://<ref>.supabase.co/rest/v1) to the `anon` and
 * `authenticated` roles. This app never uses that API — all access goes
 * through this Express server as the table owner — so the API must expose
 * nothing: users.password_hash, phone numbers, lesson notes and payment rows
 * would otherwise be one publishable key away from anyone.
 *
 * Runs on every boot after migrations, so tables added by future migrations
 * are covered too. Idempotent. A no-op on a plain Postgres without those
 * roles (local development, tests).
 *
 * The server's own role owns the tables, so row level security without
 * policies does not affect it.
 */
export async function lockDownSupabaseDataApi(): Promise<void> {
  const { rows } = await pool.query<{ rolname: string }>(
    `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`
  );
  if (rows.length === 0) return;
  const roles = rows.map((r) => r.rolname).join(', ');

  await pool.query(`
    DO $$
    DECLARE t record;
    BEGIN
      FOR t IN
        SELECT c.relname
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
           AND NOT c.relrowsecurity
      LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
      END LOOP;
    END $$;
  `);
  await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${roles}`);
  await pool.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${roles}`);
  await pool.query(`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM ${roles}`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${roles}`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${roles}`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM ${roles}`);
}

// Migrations live outside src/ so tsc never compiles them; the path resolves
// identically from src/services (ts-node-dev) and dist/services (production
// build): ../../migrations === <server root>/migrations.
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

/**
 * Schema management now goes through node-pg-migrate
 * (docs/DATA_ARCHITECTURE.md, Phase 0). The former imperative DDL in this
 * file was snapshotted verbatim into migrations/0001_baseline.js — it is
 * idempotent, so it applies cleanly to both fresh databases and existing
 * production databases already shaped by the old initDb(). All future schema
 * changes are new numbered files under server/migrations/, never edits here.
 */
export async function initDb(): Promise<void> {
  await runner({
    databaseUrl: { connectionString: process.env.DATABASE_URL, ssl },
    dir: MIGRATIONS_DIR,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    logger: {
      info: (msg: string) => console.log(`[migrate] ${msg}`),
      warn: (msg: string) => console.warn(`[migrate] ${msg}`),
      error: (msg: string) => console.error(`[migrate] ${msg}`),
    },
  });

  await lockDownSupabaseDataApi();

  // Data seeding stays here (not in a migration): ON CONFLICT DO NOTHING
  // preserves any admin edits across restarts/redeploys, and the defs are
  // TypeScript imports the plain-JS migration files can't reach.
  const now = Date.now();
  for (const def of CURRICULUM_PART_DEFS) {
    await pool.query(
      `INSERT INTO curriculum_part_templates (part_key, part_order, title, content, key_points, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (part_key) DO NOTHING`,
      [def.partKey, def.partOrder, def.title, def.content, JSON.stringify(def.keyPoints), now]
    );
  }
}

export default pool;
