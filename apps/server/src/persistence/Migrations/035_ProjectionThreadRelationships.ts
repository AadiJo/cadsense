import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN purpose TEXT NOT NULL DEFAULT 'general'
  `;
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN parent_thread_id TEXT
  `;
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN review_run_id TEXT
  `;

  // Recover explicit ownership for legacy review children from their own link activity. The
  // thread-id fallback only runs during migration so runtime routing no longer depends on naming.
  yield* sql`
    UPDATE projection_threads
    SET
      purpose = 'cad-review',
      parent_thread_id = COALESCE(
        (
          SELECT json_extract(activity.payload_json, '$.parentThreadId')
          FROM projection_thread_activities AS activity
          WHERE activity.thread_id = projection_threads.thread_id
            AND activity.kind = 'cad-review.child-thread.linked'
          ORDER BY activity.created_at DESC, activity.activity_id DESC
          LIMIT 1
        ),
        CASE
          WHEN instr(projection_threads.thread_id, ':cad-review:') > 0
          THEN substr(
            projection_threads.thread_id,
            1,
            instr(projection_threads.thread_id, ':cad-review:') - 1
          )
          ELSE NULL
        END
      ),
      review_run_id = COALESCE(
        (
          SELECT json_extract(activity.payload_json, '$.reviewRunId')
          FROM projection_thread_activities AS activity
          WHERE activity.thread_id = projection_threads.thread_id
            AND activity.kind = 'cad-review.child-thread.linked'
          ORDER BY activity.created_at DESC, activity.activity_id DESC
          LIMIT 1
        ),
        CASE
          WHEN instr(projection_threads.thread_id, ':cad-review:') > 0
          THEN substr(
            substr(
              projection_threads.thread_id,
              instr(projection_threads.thread_id, ':cad-review:') + length(':cad-review:')
            ),
            1,
            instr(
              substr(
                projection_threads.thread_id,
                instr(projection_threads.thread_id, ':cad-review:') + length(':cad-review:')
              ),
              ':'
            ) - 1
          )
          ELSE NULL
        END
      )
    WHERE EXISTS (
      SELECT 1
      FROM projection_thread_activities AS activity
      WHERE activity.thread_id = projection_threads.thread_id
        AND activity.kind = 'cad-review.child-thread.linked'
    ) OR instr(projection_threads.thread_id, ':cad-review:') > 0
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent_review
    ON projection_threads(parent_thread_id, review_run_id, purpose)
  `;
});
