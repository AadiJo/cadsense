/**
 * Repairs databases where migration 031 is recorded in `effect_sql_migrations`
 * but `external_context_json` is missing on projection tables.
 *
 * Effect's SQLite migrator inserts migration rows before running migration SQL;
 * SQLite DDL can auto-commit in ways that break transactional rollback, leaving
 * the schema out of sync with the migration ledger. This migration is fully
 * idempotent and safe to re-run.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!projectColumns.some((column) => column.name === "external_context_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN external_context_json TEXT
    `;
  }

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "external_context_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN external_context_json TEXT
    `;
  }
});
