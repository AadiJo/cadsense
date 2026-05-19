import {
  OnshapeConnectionId,
  OnshapeEntity,
  OnshapeEntityId,
  OnshapeIndexRun,
  OnshapeThreadContext,
  ProjectId,
  ThreadId,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  OnshapeIndexRepository,
  PersistedOnshapeConnection,
  type OnshapeIndexRepositoryShape,
} from "../Services/OnshapeIndex.ts";

const OnshapeConnectionRow = PersistedOnshapeConnection.mapFields(
  Struct.assign({
    secretKeyConfigured: Schema.Number,
  }),
);
type OnshapeConnectionRow = typeof OnshapeConnectionRow.Type;
const decodeConnectionRow = (row: OnshapeConnectionRow): PersistedOnshapeConnection => ({
  connectionId: row.connectionId,
  displayName: row.displayName,
  baseUrl: row.baseUrl,
  accessKeyId: row.accessKeyId,
  secretKeyCiphertext: row.secretKeyCiphertext,
  secretKeyConfigured: row.secretKeyConfigured > 0,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
const OnshapeIndexRunRow = OnshapeIndexRun.mapFields(
  Struct.assign({
    endpointCounts: Schema.fromJsonString(Schema.Record(Schema.String, Schema.Number)),
  }),
);
const OnshapeEntityRow = OnshapeEntity.mapFields(
  Struct.assign({
    breadcrumb: Schema.fromJsonString(Schema.Array(Schema.String)),
  }),
);
const OnshapeThreadContextRow = Schema.Struct({
  threadId: ThreadId,
  projectId: Schema.NullOr(ProjectId),
  context: Schema.fromJsonString(OnshapeThreadContext.fields.context),
  createdAt: OnshapeThreadContext.fields.createdAt,
  updatedAt: OnshapeThreadContext.fields.updatedAt,
});

const makeOnshapeIndexRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const ensureOnshapeSchema = Effect.gen(function* () {
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
  }).pipe(Effect.mapError(toPersistenceSqlError("OnshapeIndexRepository.ensureSchema")));

  yield* ensureOnshapeSchema;

  const upsertConnectionRow = SqlSchema.void({
    Request: PersistedOnshapeConnection,
    execute: (row) =>
      sql`
        INSERT INTO onshape_connections (
          connection_id,
          display_name,
          base_url,
          access_key_id,
          secret_key_ciphertext,
          created_at,
          updated_at
        )
        VALUES (
          ${row.connectionId},
          ${row.displayName},
          ${row.baseUrl},
          ${row.accessKeyId},
          ${row.secretKeyCiphertext},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (connection_id)
        DO UPDATE SET
          display_name = excluded.display_name,
          base_url = excluded.base_url,
          access_key_id = excluded.access_key_id,
          secret_key_ciphertext = excluded.secret_key_ciphertext,
          updated_at = excluded.updated_at
      `,
  });

  const listConnectionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: OnshapeConnectionRow,
    execute: () =>
      sql`
        SELECT
          connection_id AS "connectionId",
          display_name AS "displayName",
          base_url AS "baseUrl",
          access_key_id AS "accessKeyId",
          secret_key_ciphertext AS "secretKeyCiphertext",
          CASE WHEN length(secret_key_ciphertext) > 0 THEN 1 ELSE 0 END AS "secretKeyConfigured",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM onshape_connections
        ORDER BY display_name ASC, connection_id ASC
      `,
  });

  const getConnectionRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ connectionId: OnshapeConnectionId }),
    Result: OnshapeConnectionRow,
    execute: ({ connectionId }) =>
      sql`
        SELECT
          connection_id AS "connectionId",
          display_name AS "displayName",
          base_url AS "baseUrl",
          access_key_id AS "accessKeyId",
          secret_key_ciphertext AS "secretKeyCiphertext",
          CASE WHEN length(secret_key_ciphertext) > 0 THEN 1 ELSE 0 END AS "secretKeyConfigured",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM onshape_connections
        WHERE connection_id = ${connectionId}
        LIMIT 1
      `,
  });

  const upsertRunRow = SqlSchema.void({
    Request: OnshapeIndexRun,
    execute: (row) =>
      sql`
        INSERT INTO onshape_index_runs (
          run_id,
          connection_id,
          scope_entity_id,
          status,
          planned_requests,
          completed_requests,
          skipped_requests,
          rate_limited_requests,
          endpoint_counts_json,
          started_at,
          finished_at,
          next_allowed_at,
          last_error
        )
        VALUES (
          ${row.runId},
          ${row.connectionId},
          ${row.scopeEntityId},
          ${row.status},
          ${row.plannedRequests},
          ${row.completedRequests},
          ${row.skippedRequests},
          ${row.rateLimitedRequests},
          ${JSON.stringify(row.endpointCounts)},
          ${row.startedAt},
          ${row.finishedAt},
          ${row.nextAllowedAt},
          ${row.lastError}
        )
        ON CONFLICT (run_id)
        DO UPDATE SET
          status = excluded.status,
          planned_requests = excluded.planned_requests,
          completed_requests = excluded.completed_requests,
          skipped_requests = excluded.skipped_requests,
          rate_limited_requests = excluded.rate_limited_requests,
          endpoint_counts_json = excluded.endpoint_counts_json,
          finished_at = excluded.finished_at,
          next_allowed_at = excluded.next_allowed_at,
          last_error = excluded.last_error
      `,
  });

  const getLatestRunRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ connectionId: OnshapeConnectionId }),
    Result: OnshapeIndexRunRow,
    execute: ({ connectionId }) =>
      sql`
        SELECT
          run_id AS "runId",
          connection_id AS "connectionId",
          scope_entity_id AS "scopeEntityId",
          status,
          planned_requests AS "plannedRequests",
          completed_requests AS "completedRequests",
          skipped_requests AS "skippedRequests",
          rate_limited_requests AS "rateLimitedRequests",
          endpoint_counts_json AS "endpointCounts",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          next_allowed_at AS "nextAllowedAt",
          last_error AS "lastError"
        FROM onshape_index_runs
        WHERE connection_id = ${connectionId}
        ORDER BY started_at DESC, run_id DESC
        LIMIT 1
      `,
  });

  const upsertEntityRow = SqlSchema.void({
    Request: OnshapeEntity,
    execute: (row) =>
      sql`
        INSERT INTO onshape_entities (
          entity_id,
          connection_id,
          parent_entity_id,
          kind,
          name,
          breadcrumb_json,
          document_id,
          wvm_kind,
          wvm_id,
          element_id,
          element_type,
          part_id,
          url,
          modified_at,
          indexed_at,
          metadata_hash
        )
        VALUES (
          ${row.entityId},
          ${row.connectionId},
          ${row.parentEntityId},
          ${row.kind},
          ${row.name},
          ${JSON.stringify(row.breadcrumb)},
          ${row.documentId},
          ${row.wvmKind},
          ${row.wvmId},
          ${row.elementId},
          ${row.elementType},
          ${row.partId},
          ${row.url},
          ${row.modifiedAt},
          ${row.indexedAt},
          ${row.metadataHash}
        )
        ON CONFLICT (entity_id)
        DO UPDATE SET
          connection_id = excluded.connection_id,
          parent_entity_id = excluded.parent_entity_id,
          kind = excluded.kind,
          name = excluded.name,
          breadcrumb_json = excluded.breadcrumb_json,
          document_id = excluded.document_id,
          wvm_kind = excluded.wvm_kind,
          wvm_id = excluded.wvm_id,
          element_id = excluded.element_id,
          element_type = excluded.element_type,
          part_id = excluded.part_id,
          url = excluded.url,
          modified_at = excluded.modified_at,
          indexed_at = excluded.indexed_at,
          metadata_hash = excluded.metadata_hash
      `,
  });

  const upsertSearchRow = SqlSchema.void({
    Request: Schema.Struct({
      entityId: OnshapeEntityId,
      connectionId: OnshapeConnectionId,
      searchText: Schema.String,
    }),
    execute: (row) =>
      sql`
        INSERT INTO onshape_entity_search (
          entity_id,
          connection_id,
          search_text
        )
        VALUES (
          ${row.entityId},
          ${row.connectionId},
          ${row.searchText}
        )
        ON CONFLICT (entity_id)
        DO UPDATE SET
          connection_id = excluded.connection_id,
          search_text = excluded.search_text
      `,
  });

  const searchEntityRows = SqlSchema.findAll({
    Request: Schema.Struct({
      connectionId: Schema.optional(OnshapeConnectionId),
      query: Schema.String,
      limit: Schema.Number,
    }),
    Result: OnshapeEntityRow,
    execute: ({ connectionId, query, limit }) => {
      const likeQuery = `%${query.trim().toLowerCase()}%`;
      return connectionId === undefined
        ? sql`
            SELECT
              entities.entity_id AS "entityId",
              entities.connection_id AS "connectionId",
              entities.parent_entity_id AS "parentEntityId",
              entities.kind,
              entities.name,
              entities.breadcrumb_json AS "breadcrumb",
              entities.document_id AS "documentId",
              entities.wvm_kind AS "wvmKind",
              entities.wvm_id AS "wvmId",
              entities.element_id AS "elementId",
              entities.element_type AS "elementType",
              entities.part_id AS "partId",
              entities.url,
              entities.modified_at AS "modifiedAt",
              entities.indexed_at AS "indexedAt",
              entities.metadata_hash AS "metadataHash"
            FROM onshape_entity_search search
            INNER JOIN onshape_entities entities
              ON entities.entity_id = search.entity_id
            WHERE lower(search.search_text) LIKE ${likeQuery}
            ORDER BY entities.kind ASC, entities.name ASC
            LIMIT ${limit}
          `
        : sql`
            SELECT
              entities.entity_id AS "entityId",
              entities.connection_id AS "connectionId",
              entities.parent_entity_id AS "parentEntityId",
              entities.kind,
              entities.name,
              entities.breadcrumb_json AS "breadcrumb",
              entities.document_id AS "documentId",
              entities.wvm_kind AS "wvmKind",
              entities.wvm_id AS "wvmId",
              entities.element_id AS "elementId",
              entities.element_type AS "elementType",
              entities.part_id AS "partId",
              entities.url,
              entities.modified_at AS "modifiedAt",
              entities.indexed_at AS "indexedAt",
              entities.metadata_hash AS "metadataHash"
            FROM onshape_entity_search search
            INNER JOIN onshape_entities entities
              ON entities.entity_id = search.entity_id
            WHERE search.connection_id = ${connectionId}
              AND lower(search.search_text) LIKE ${likeQuery}
            ORDER BY entities.kind ASC, entities.name ASC
            LIMIT ${limit}
          `;
    },
  });

  const getEntityRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ entityId: OnshapeEntityId }),
    Result: OnshapeEntityRow,
    execute: ({ entityId }) =>
      sql`
        SELECT
          entity_id AS "entityId",
          connection_id AS "connectionId",
          parent_entity_id AS "parentEntityId",
          kind,
          name,
          breadcrumb_json AS "breadcrumb",
          document_id AS "documentId",
          wvm_kind AS "wvmKind",
          wvm_id AS "wvmId",
          element_id AS "elementId",
          element_type AS "elementType",
          part_id AS "partId",
          url,
          modified_at AS "modifiedAt",
          indexed_at AS "indexedAt",
          metadata_hash AS "metadataHash"
        FROM onshape_entities
        WHERE entity_id = ${entityId}
        LIMIT 1
      `,
  });

  const upsertThreadContextRow = SqlSchema.void({
    Request: OnshapeThreadContext,
    execute: (row) =>
      sql`
        INSERT INTO onshape_thread_contexts (
          thread_id,
          project_id,
          context_json,
          created_at,
          updated_at
        )
        VALUES (
          ${row.threadId},
          ${row.projectId},
          ${JSON.stringify(row.context)},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          context_json = excluded.context_json,
          updated_at = excluded.updated_at
      `,
  });

  const getThreadContextRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: OnshapeThreadContextRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          context_json AS "context",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM onshape_thread_contexts
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  return {
    upsertConnection: (connection) =>
      upsertConnectionRow(connection).pipe(
        Effect.mapError(toPersistenceSqlError("OnshapeIndexRepository.upsertConnection")),
      ),
    listConnections: () =>
      listConnectionRows(undefined).pipe(
        Effect.map((rows) => rows.map(decodeConnectionRow)),
        Effect.mapError(toPersistenceSqlError("OnshapeIndexRepository.listConnections")),
      ),
    getConnection: (connectionId) =>
      getConnectionRow({ connectionId }).pipe(
        Effect.map(Option.map(decodeConnectionRow)),
        Effect.mapError(toPersistenceSqlError("OnshapeIndexRepository.getConnection")),
      ),
    upsertIndexRun: (run) =>
      upsertRunRow(run).pipe(
        Effect.mapError(toPersistenceSqlError("OnshapeIndexRepository.upsertIndexRun")),
      ),
    getLatestIndexRun: (connectionId) =>
      getLatestRunRow({ connectionId }).pipe(
        Effect.mapError(toPersistenceSqlError("OnshapeIndexRepository.getLatestIndexRun")),
      ),
    upsertEntities: (entities) =>
      Effect.forEach(
        entities,
        (entity) =>
          Effect.all([
            upsertEntityRow(entity),
            upsertSearchRow({
              entityId: entity.entityId,
              connectionId: entity.connectionId,
              searchText: [...entity.breadcrumb, entity.kind, entity.name].join(" ").toLowerCase(),
            }),
          ]),
        { concurrency: 1 },
      ).pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("OnshapeIndexRepository.upsertEntities")),
      ),
    searchEntities: (input) =>
      searchEntityRows(input).pipe(
        Effect.mapError(toPersistenceSqlError("OnshapeIndexRepository.searchEntities")),
      ),
    getEntity: (entityId) =>
      getEntityRow({ entityId }).pipe(
        Effect.mapError(toPersistenceSqlError("OnshapeIndexRepository.getEntity")),
      ),
    upsertThreadContext: (context) =>
      upsertThreadContextRow(context).pipe(
        Effect.mapError(toPersistenceSqlError("OnshapeIndexRepository.upsertThreadContext")),
      ),
    getThreadContext: (threadId) =>
      getThreadContextRow({ threadId }).pipe(
        Effect.mapError(toPersistenceSqlError("OnshapeIndexRepository.getThreadContext")),
      ),
  } satisfies OnshapeIndexRepositoryShape;
});

export const OnshapeIndexRepositoryLive = Layer.effect(
  OnshapeIndexRepository,
  makeOnshapeIndexRepository,
);
