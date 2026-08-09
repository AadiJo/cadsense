import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_ProjectionThreadRelationships", (it) => {
  it.effect("adds relationship columns and recovers legacy CAD review children", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 34 });

      for (const threadId of [
        "parent:cad-review:review-from-activity:synthesis:child-a",
        "parent:cad-review:review-from-id:reviewing:child-b",
        "ordinary-thread",
      ]) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id,
            project_id,
            title,
            model_selection_json,
            runtime_mode,
            interaction_mode,
            branch,
            worktree_path,
            latest_turn_id,
            created_at,
            updated_at,
            archived_at,
            latest_user_message_at,
            pending_approval_count,
            pending_user_input_count,
            has_actionable_proposed_plan,
            deleted_at
          ) VALUES (
            ${threadId},
            'project-1',
            ${threadId},
            '{"instanceId":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-08-09T00:00:00.000Z',
            '2026-08-09T00:00:00.000Z',
            NULL,
            NULL,
            0,
            0,
            0,
            NULL
          )
        `;
      }

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        ) VALUES (
          'activity-link',
          'parent:cad-review:review-from-activity:synthesis:child-a',
          NULL,
          'info',
          'cad-review.child-thread.linked',
          'linked',
          '{"parentThreadId":"explicit-parent","reviewRunId":"explicit-review"}',
          '2026-08-09T00:00:01.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 35 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly purpose: string;
        readonly parentThreadId: string | null;
        readonly reviewRunId: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          purpose,
          parent_thread_id AS "parentThreadId",
          review_run_id AS "reviewRunId"
        FROM projection_threads
        ORDER BY thread_id
      `;

      assert.deepStrictEqual(rows, [
        {
          threadId: "ordinary-thread",
          purpose: "general",
          parentThreadId: null,
          reviewRunId: null,
        },
        {
          threadId: "parent:cad-review:review-from-activity:synthesis:child-a",
          purpose: "cad-review",
          parentThreadId: "explicit-parent",
          reviewRunId: "explicit-review",
        },
        {
          threadId: "parent:cad-review:review-from-id:reviewing:child-b",
          purpose: "cad-review",
          parentThreadId: "parent",
          reviewRunId: "review-from-id",
        },
      ]);
    }),
  );
});
