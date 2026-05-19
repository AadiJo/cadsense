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

  yield* sql`
    CREATE TABLE IF NOT EXISTS onshape_connections (
      connection_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      access_key_id TEXT NOT NULL,
      secret_key_ciphertext TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS onshape_index_runs (
      run_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      scope_entity_id TEXT,
      status TEXT NOT NULL,
      planned_requests INTEGER NOT NULL,
      completed_requests INTEGER NOT NULL,
      skipped_requests INTEGER NOT NULL,
      rate_limited_requests INTEGER NOT NULL,
      endpoint_counts_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      next_allowed_at TEXT,
      last_error TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS onshape_entities (
      entity_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      parent_entity_id TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      breadcrumb_json TEXT NOT NULL,
      document_id TEXT,
      wvm_kind TEXT,
      wvm_id TEXT,
      element_id TEXT,
      element_type TEXT,
      part_id TEXT,
      url TEXT,
      modified_at TEXT,
      indexed_at TEXT NOT NULL,
      metadata_hash TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS onshape_entity_search (
      entity_id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      search_text TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS onshape_thread_contexts (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT,
      context_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_onshape_entities_connection_parent
    ON onshape_entities(connection_id, parent_entity_id, kind, name)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_onshape_entities_document
    ON onshape_entities(connection_id, document_id, element_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_onshape_search_connection_text
    ON onshape_entity_search(connection_id, search_text)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_onshape_index_runs_connection_started
    ON onshape_index_runs(connection_id, started_at)
  `;
});
