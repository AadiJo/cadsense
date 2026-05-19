import { CadReviewReport } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadReviewsInput,
  ListProjectionThreadReviewsInput,
  ProjectionThreadReview,
  ProjectionThreadReviewRepository,
  type ProjectionThreadReviewRepositoryShape,
} from "../Services/ProjectionThreadReviews.ts";

const ProjectionThreadReviewDbRow = ProjectionThreadReview.mapFields(
  Struct.assign({
    review: Schema.fromJsonString(CadReviewReport),
  }),
);
const ProjectionThreadReviewWriteRow = ProjectionThreadReview.mapFields(
  Struct.assign({
    review: Schema.String,
  }),
);

const makeProjectionThreadReviewRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadReviewRow = SqlSchema.void({
    Request: ProjectionThreadReviewWriteRow,
    execute: (row) => sql`
      INSERT INTO projection_thread_reviews (
        review_id,
        thread_id,
        review,
        created_at,
        updated_at
      )
      VALUES (
        ${row.reviewId},
        ${row.threadId},
        ${row.review},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (review_id)
      DO UPDATE SET
        thread_id = excluded.thread_id,
        review = excluded.review,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const listProjectionThreadReviewRows = SqlSchema.findAll({
    Request: ListProjectionThreadReviewsInput,
    Result: ProjectionThreadReviewDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        review_id AS "reviewId",
        thread_id AS "threadId",
        review,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_reviews
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, review_id ASC
    `,
  });

  const deleteProjectionThreadReviewRows = SqlSchema.void({
    Request: DeleteProjectionThreadReviewsInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_reviews
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionThreadReviewRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadReviewRow({
      ...row,
      review: JSON.stringify(row.review),
    }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadReviewRepository.upsert:query")),
    );

  const listByThreadId: ProjectionThreadReviewRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadReviewRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadReviewRepository.listByThreadId:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadReviewRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadReviewRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadReviewRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadReviewRepositoryShape;
});

export const ProjectionThreadReviewRepositoryLive = Layer.effect(
  ProjectionThreadReviewRepository,
  makeProjectionThreadReviewRepository,
);
