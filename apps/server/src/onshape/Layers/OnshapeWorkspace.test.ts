import {
  OnshapeConnectionId,
  type OnshapeEntity,
  type OnshapeIndexRun,
  type OnshapeThreadContext,
} from "@cadsense/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { zipSync } from "fflate";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import {
  OnshapeIndexRepository,
  type OnshapeIndexRepositoryShape,
  type PersistedOnshapeConnection,
} from "../../persistence/Services/OnshapeIndex.ts";
import { OnshapeWorkspace } from "../Services/OnshapeWorkspace.ts";
import {
  OnshapeWorkspaceLive,
  onshape3mfTranslationRequestBody,
  onshapeObjExportRequestBody,
  onshapeStlTranslationRequestBody,
  onshapeStepTranslationRequestBody,
} from "./OnshapeWorkspace.ts";

const textEncoder = new TextEncoder();

const connectionId = OnshapeConnectionId.make("onshape_test");

const testConnection = {
  connectionId,
  displayName: "Test Onshape",
  baseUrl: "https://cad.onshape.com",
  accessKeyId: "access-key",
  secretKeyConfigured: true,
  secretKeyCiphertext: "server-secret-store:onshape",
  createdAt: "2026-05-15T00:00:00.000Z",
  updatedAt: "2026-05-15T00:00:00.000Z",
};

function optionFromNullable<T>(value: T | null | undefined): Option.Option<T> {
  return value === null || value === undefined ? Option.none() : Option.some(value);
}

function makeRepositoryLayer() {
  return Layer.sync(OnshapeIndexRepository, () => {
    const connections = new Map<string, PersistedOnshapeConnection>([
      [connectionId, testConnection],
    ]);
    const runs: OnshapeIndexRun[] = [];
    const entities = new Map<string, OnshapeEntity>();
    const threadContexts = new Map<string, OnshapeThreadContext>();

    return {
      upsertConnection: (connection) =>
        Effect.sync(() => {
          connections.set(connection.connectionId, connection);
        }),
      listConnections: () => Effect.succeed(Array.from(connections.values())),
      getConnection: (id) => Effect.succeed(optionFromNullable(connections.get(id))),
      upsertIndexRun: (run) =>
        Effect.sync(() => {
          const existingIndex = runs.findIndex((existing) => existing.runId === run.runId);
          if (existingIndex >= 0) {
            runs[existingIndex] = run;
          } else {
            runs.push(run);
          }
        }),
      getLatestIndexRun: (id) =>
        Effect.succeed(optionFromNullable(runs.findLast((run) => run.connectionId === id))),
      upsertEntities: (rows) =>
        Effect.sync(() => {
          for (const entity of rows) {
            entities.set(entity.entityId, entity);
          }
        }),
      searchEntities: ({ connectionId: scopedConnectionId, query, limit }) =>
        Effect.succeed(
          Array.from(entities.values())
            .filter((entity) =>
              scopedConnectionId === undefined ? true : entity.connectionId === scopedConnectionId,
            )
            .filter((entity) =>
              [...entity.breadcrumb, entity.kind, entity.name]
                .join(" ")
                .toLowerCase()
                .includes(query.trim().toLowerCase()),
            )
            .slice(0, limit),
        ),
      getEntity: (entityId) => Effect.succeed(optionFromNullable(entities.get(entityId))),
      upsertThreadContext: (context) =>
        Effect.sync(() => {
          threadContexts.set(context.threadId, context);
        }),
      getThreadContext: (threadId) =>
        Effect.succeed(optionFromNullable(threadContexts.get(threadId))),
    } satisfies OnshapeIndexRepositoryShape;
  });
}

function makeSecretStoreLayer() {
  return Layer.succeed(ServerSecretStore, {
    get: (name) =>
      Effect.succeed(name === `onshape-${connectionId}` ? textEncoder.encode("secret-key") : null),
    set: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(textEncoder.encode("secret-key")),
    remove: () => Effect.void,
  });
}

function makeOnshapeHttpLayer(
  handler: (url: URL) => Response | unknown,
  requests: Ref.Ref<string[]>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const url = new URL(request.url);
        yield* Ref.update(requests, (existing) => [...existing, `${url.pathname}${url.search}`]);
        const response = handler(url);
        return HttpClientResponse.fromWeb(
          request,
          response instanceof Response ? response : Response.json(response),
        );
      }),
    ),
  );
}

const makeLayer = (handler: (url: URL) => unknown, requests: Ref.Ref<string[]>) => {
  const repositoryLayer = makeRepositoryLayer();
  const workspaceLayer = OnshapeWorkspaceLive.pipe(
    Layer.provideMerge(repositoryLayer),
    Layer.provideMerge(makeSecretStoreLayer()),
    Layer.provideMerge(makeOnshapeHttpLayer(handler, requests)),
    Layer.provideMerge(NodeServices.layer),
  );
  return Layer.mergeAll(workspaceLayer, repositoryLayer);
};

it("onshapeObjExportRequestBody matches preview OBJ export settings", () => {
  const baseRef = { baseUrl: "https://cad.onshape.com" as const };
  assert.deepStrictEqual(
    onshapeObjExportRequestBody({
      entityKind: "assembly",
      reference: baseRef,
    }),
    {
      storeInDocument: false,
      notifyUser: false,
      excludeHiddenEntities: true,
      grouping: true,
      meshParams: {
        resolution: "MEDIUM",
        unit: "METER",
      },
    },
  );
  assert.deepStrictEqual(
    onshapeObjExportRequestBody({
      entityKind: "part",
      reference: { ...baseRef, partId: "JHD" },
    }),
    {
      storeInDocument: false,
      notifyUser: false,
      excludeHiddenEntities: true,
      grouping: false,
      meshParams: {
        resolution: "MEDIUM",
        unit: "METER",
      },
      partIds: "JHD",
    },
  );
});

it("onshapeStepTranslationRequestBody flattens assembly STEP exports", () => {
  const baseRef = { baseUrl: "https://cad.onshape.com" as const };
  assert.deepStrictEqual(
    onshapeStepTranslationRequestBody({
      entityKind: "assembly",
      reference: baseRef,
    }),
    {
      formatName: "STEP",
      storeInDocument: false,
      flattenAssemblies: true,
      allowFaultyParts: true,
    },
  );
  assert.deepStrictEqual(
    onshapeStepTranslationRequestBody({
      entityKind: "part",
      reference: { ...baseRef, partId: "JHD" },
    }),
    {
      formatName: "STEP",
      storeInDocument: false,
      partIds: "JHD",
    },
  );
});

it("onshapeStlTranslationRequestBody requests binary preview STL exports", () => {
  const baseRef = { baseUrl: "https://cad.onshape.com" as const };
  assert.deepStrictEqual(
    onshapeStlTranslationRequestBody({
      entityKind: "assembly",
      reference: baseRef,
    }),
    {
      formatName: "STL",
      storeInDocument: false,
      notifyUser: false,
      stlMode: "BINARY",
      unit: "METER",
      resolution: "MEDIUM",
      grouping: true,
      allowFaultyParts: true,
    },
  );
  assert.deepStrictEqual(
    onshapeStlTranslationRequestBody({
      entityKind: "part",
      reference: { ...baseRef, partId: "JHD" },
    }),
    {
      formatName: "STL",
      storeInDocument: false,
      notifyUser: false,
      stlMode: "BINARY",
      unit: "METER",
      resolution: "MEDIUM",
      grouping: true,
      partIds: "JHD",
    },
  );
});

it("onshape3mfTranslationRequestBody requests color-preserving preview exports", () => {
  const baseRef = { baseUrl: "https://cad.onshape.com" as const };
  assert.deepStrictEqual(
    onshape3mfTranslationRequestBody({
      entityKind: "assembly",
      reference: baseRef,
    }),
    {
      formatName: "3MF",
      storeInDocument: false,
      notifyUser: false,
      unit: "METER",
      resolution: "coarse",
      grouping: true,
      allowFaultyParts: true,
    },
  );
  assert.deepStrictEqual(
    onshape3mfTranslationRequestBody({
      entityKind: "part",
      reference: { ...baseRef, partId: "JHD" },
    }),
    {
      formatName: "3MF",
      storeInDocument: false,
      notifyUser: false,
      unit: "METER",
      resolution: "coarse",
      grouping: true,
      partIds: "JHD",
    },
  );
});

it.effect("OnshapeWorkspaceLive refreshIndex indexes connection documents", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<string[]>([]);
    yield* Effect.gen(function* () {
      const workspace = yield* OnshapeWorkspace;
      const result = yield* workspace.refreshIndex({ connectionId });
      const search = yield* workspace.searchIndex({
        connectionId,
        query: "bracket",
        limit: 10,
      });
      const recordedRequests = yield* Ref.get(requests);

      assert.deepStrictEqual(recordedRequests, ["/api/v10/documents?limit=100"]);
      assert.equal(result.run.status, "ready");
      assert.equal(result.entities[0]?.name, "Bracket");
      assert.equal(search.entities[0]?.url, "https://cad.onshape.com/documents/doc-1/w/ws-1");
    }).pipe(
      Effect.provide(
        makeLayer(
          () => ({
            items: [
              {
                id: "doc-1",
                name: "Bracket",
                defaultWorkspace: { id: "ws-1" },
                modifiedAt: "2026-05-14T12:00:00.000Z",
              },
            ],
          }),
          requests,
        ),
      ),
    );
  }),
);

it.effect("OnshapeWorkspaceLive importUrl indexes document elements from pasted links", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<string[]>([]);
    yield* Effect.gen(function* () {
      const workspace = yield* OnshapeWorkspace;
      const result = yield* workspace.importUrl({
        connectionId,
        url: "https://cad.onshape.com/documents/doc-2/w/ws-2/e/el-2",
        includeParts: false,
      });
      const entityNames = result.entities.map((entity) => entity.name);
      const recordedRequests = yield* Ref.get(requests);

      assert.deepStrictEqual(recordedRequests, [
        "/api/v10/documents/d/doc-2/w/ws-2/contents?elementId=el-2",
      ]);
      assert.deepStrictEqual(entityNames, ["Gearbox", "Main Assembly"]);
      assert.equal(result.entities[1]?.parentEntityId, result.entities[0]?.entityId);
      assert.equal(
        result.entities[1]?.url,
        "https://cad.onshape.com/documents/doc-2/w/ws-2/e/el-2",
      );
    }).pipe(
      Effect.provide(
        makeLayer(
          () => ({
            name: "Gearbox",
            elements: [
              { id: "el-1", name: "Ignored Part Studio", elementType: "PARTSTUDIO" },
              { id: "el-2", name: "Main Assembly", elementType: "ASSEMBLY" },
            ],
          }),
          requests,
        ),
      ),
    );
  }),
);

it.effect(
  "OnshapeWorkspaceLive syncProject translates a color-preserving part studio 3MF into the workspace",
  () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<string[]>([]);
      yield* Effect.gen(function* () {
        const workspace = yield* OnshapeWorkspace;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cadsense-onshape-sync-",
        });
        const result = yield* workspace.syncProject({
          cwd: tempDir,
          context: {
            connectionId,
            entityId: "onshape_test:element:doc-3:w:ws-3:el-3",
            entityKind: "element",
            name: "Part Studio",
            breadcrumb: ["Robot", "Part Studio"],
            reference: {
              baseUrl: "https://cad.onshape.com",
              documentId: "doc-3",
              wvmKind: "w",
              wvmId: "ws-3",
              elementId: "el-3",
            },
          },
        });
        const recordedRequests = yield* Ref.get(requests);
        const contents = yield* fileSystem.readFileString(
          path.join(tempDir, "onshape-sync/current.3mf"),
        );

        assert.equal(result.relativePath, "onshape-sync/current.3mf");
        assert.equal(result.format, "3mf");
        assert.equal(contents, "3MF-DATA");
        assert.deepStrictEqual(recordedRequests, [
          "/api/v10/partstudios/d/doc-3/w/ws-3/e/el-3/translations",
          "/api/v10/documents/d/doc-3/externaldata/external-3mf",
        ]);
      }).pipe(
        Effect.provide(
          makeLayer((url) => {
            if (url.pathname.endsWith("/translations")) {
              return {
                id: "translation-3mf",
                requestState: "DONE",
                resultExternalDataIds: ["external-3mf"],
              };
            }
            if (url.pathname === "/api/v10/documents/d/doc-3/externaldata/external-3mf") {
              return new Response("3MF-DATA");
            }
            return {};
          }, requests),
        ),
      );
    }),
);

it.effect("OnshapeWorkspaceLive syncProject translates an assembly 3MF before OBJ fallback", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<string[]>([]);
    yield* Effect.gen(function* () {
      const workspace = yield* OnshapeWorkspace;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "cadsense-onshape-sync-assembly-3mf-",
      });
      const result = yield* workspace.syncProject({
        cwd: tempDir,
        context: {
          connectionId,
          entityId: "onshape_test:assembly:doc-asm:w:ws-asm:el-asm",
          entityKind: "assembly",
          name: "Robot",
          breadcrumb: ["Robot"],
          reference: {
            baseUrl: "https://cad.onshape.com",
            documentId: "doc-asm",
            wvmKind: "w",
            wvmId: "ws-asm",
            elementId: "el-asm",
          },
        },
      });
      const contents = yield* fileSystem.readFileString(
        path.join(tempDir, "onshape-sync/current.3mf"),
      );
      const recordedRequests = yield* Ref.get(requests);

      assert.equal(result.relativePath, "onshape-sync/current.3mf");
      assert.equal(result.format, "3mf");
      assert.equal(contents, "ASSEMBLY-3MF");
      assert.deepStrictEqual(recordedRequests, [
        "/api/v10/assemblies/d/doc-asm/w/ws-asm/e/el-asm/translations",
        "/api/v10/documents/d/doc-asm/externaldata/external-3mf",
      ]);
    }).pipe(
      Effect.provide(
        makeLayer((url) => {
          if (url.pathname.endsWith("/translations")) {
            return {
              id: "translation-3mf",
              requestState: "DONE",
              resultExternalDataIds: ["external-3mf"],
            };
          }
          if (url.pathname === "/api/v10/documents/d/doc-asm/externaldata/external-3mf") {
            return new Response("ASSEMBLY-3MF");
          }
          return {};
        }, requests),
      ),
    );
  }),
);

it.effect("OnshapeWorkspaceLive syncProject unpacks OBJ zip exports into onshape-sync/bundle", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<string[]>([]);
    yield* Effect.gen(function* () {
      const workspace = yield* OnshapeWorkspace;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "cadsense-onshape-sync-zip-",
      });
      const result = yield* workspace.syncProject({
        cwd: tempDir,
        context: {
          connectionId,
          entityId: "onshape_test:part:doc-zip:w:ws-zip:e:el-zip:part-zip",
          entityKind: "part",
          name: "ZipPart",
          breadcrumb: [],
          reference: {
            baseUrl: "https://cad.onshape.com",
            documentId: "doc-zip",
            wvmKind: "w",
            wvmId: "ws-zip",
            elementId: "el-zip",
            partId: "part-zip",
          },
        },
      });
      const objPath = path.join(tempDir, "onshape-sync/bundle/Part.obj");
      const mtlPath = path.join(tempDir, "onshape-sync/bundle/Part.mtl");
      const obj = yield* fileSystem.readFileString(objPath);
      const mtl = yield* fileSystem.readFileString(mtlPath);
      assert.equal(result.relativePath, "onshape-sync/bundle/Part.obj");
      assert.equal(result.format, "obj");
      assert.equal(obj, "mtllib Part.mtl\nv 0 0 0\n");
      assert.equal(mtl, "newmtl m\n");
      const recordedRequests = yield* Ref.get(requests);
      assert.deepStrictEqual(recordedRequests, [
        "/api/v10/partstudios/d/doc-zip/w/ws-zip/e/el-zip/translations",
        "/api/v10/partstudios/d/doc-zip/w/ws-zip/e/el-zip/export/obj",
        "/api/v10/documents/d/doc-zip/externaldata/external-zip",
      ]);
    }).pipe(
      Effect.provide(
        makeLayer((url) => {
          if (url.pathname.endsWith("/translations")) {
            return new Response("unsupported", { status: 404 });
          }
          if (url.pathname.endsWith("/export/obj")) {
            return {
              id: "translation-zip",
              requestState: "DONE",
              resultExternalDataIds: ["external-zip"],
            };
          }
          if (url.pathname === "/api/v10/documents/d/doc-zip/externaldata/external-zip") {
            return new Response(
              zipSync({
                "Part.obj": textEncoder.encode("mtllib Part.mtl\nv 0 0 0\n"),
                "Part.mtl": textEncoder.encode("newmtl m\n"),
              }),
            );
          }
          return {};
        }, requests),
      ),
    );
  }),
);
