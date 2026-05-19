import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("032_EnsureExternalContextJsonColumns", (it) => {
  it.effect("adds external_context_json after through-30 schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 30 });

      const beforeProjects = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.ok(!beforeProjects.some((column) => column.name === "external_context_json"));

      yield* runMigrations({ toMigrationInclusive: 32 });

      const afterProjects = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.ok(afterProjects.some((column) => column.name === "external_context_json"));

      const afterThreads = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(afterThreads.some((column) => column.name === "external_context_json"));
    }),
  );

  it.effect("is idempotent when columns already exist", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* runMigrations({ toMigrationInclusive: 32 });

      const rows = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 32
      `;
      assert.equal(rows.length, 1);
      const projects = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.ok(projects.some((column) => column.name === "external_context_json"));
    }),
  );
});
