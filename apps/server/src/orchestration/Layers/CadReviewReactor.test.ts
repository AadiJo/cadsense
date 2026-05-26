import type { OrchestrationEvent } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { tryClaimCadReviewRun } from "./CadReviewReactor.ts";

describe("CadReviewReactor", () => {
  it("claims each CAD review run once across workers", async () => {
    const event = {
      type: "thread.review-requested",
      commandId: "cmd-review",
      payload: {
        threadId: "thread-1",
        reviewRunId: "cad-review-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    } as Extract<OrchestrationEvent, { type: "thread.review-requested" }>;

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        expect(yield* tryClaimCadReviewRun({ sql, event, workerId: "worker-a" })).toBe(true);
        expect(yield* tryClaimCadReviewRun({ sql, event, workerId: "worker-b" })).toBe(false);

        const claims = yield* sql<{
          readonly workerId: string;
          readonly threadId: string;
          readonly reviewRunId: string;
          readonly commandId: string;
        }>`
          SELECT
            worker_id AS "workerId",
            thread_id AS "threadId",
            review_id AS "reviewRunId",
            command_id AS "commandId"
          FROM cad_review_run_claims
        `;
        expect(claims).toEqual([
          {
            workerId: "worker-a",
            threadId: "thread-1",
            reviewRunId: "cad-review-1",
            commandId: "cmd-review",
          },
        ]);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
    );
  });
});
