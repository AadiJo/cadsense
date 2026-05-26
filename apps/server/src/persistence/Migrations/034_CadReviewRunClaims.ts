import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS cad_review_run_claims (
      review_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      claimed_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_cad_review_run_claims_thread
    ON cad_review_run_claims(thread_id, claimed_at)
  `;
});
