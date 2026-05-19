import * as Crypto from "node:crypto";
import * as OS from "node:os";

import {
  type OnshapeConnection,
  type OnshapeConnectionId,
  type OnshapeContext,
  type OnshapeElementType,
  type OnshapeEntity,
  type OnshapeIndexRun,
} from "@cadsense/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { CAD_SYNC_DIRECTORY } from "@cadsense/shared/cad";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { OnshapeIndexRepository } from "../../persistence/Services/OnshapeIndex.ts";
import {
  OnshapeWorkspace,
  OnshapeWorkspaceFailure,
  type OnshapeWorkspaceShape,
} from "../Services/OnshapeWorkspace.ts";
import {
  compactDownloadedBytes,
  formatBytesHeadHex,
  isZipArchive,
  looksLikeObjText,
  tryExtractObjBundle,
} from "../onshapeObjBundle.ts";

interface ParsedOnshapeUrl {
  readonly baseUrl: string;
  readonly documentId: string;
  readonly wvmKind: "w" | "v" | "m";
  readonly wvmId: string;
  readonly elementId: string | null;
}

interface RequestMetrics {
  readonly endpoint: string;
  readonly status: number;
  readonly rateLimitRemaining: string | null;
  readonly retryAfter: string | null;
}

const textEncoder = new TextEncoder();
const DEFAULT_DOCUMENT_LIST_LIMIT = "100";
const SYNC_RELATIVE_PATH = "onshape-sync/current.obj";
// STEP CAD output (slower web previews): "onshape-sync/current.step";
// ~half as many poll round-trips as 2s×60 while keeping ~120s worst-case wait.
const TRANSLATION_POLL_INTERVAL = Duration.seconds(4);
const TRANSLATION_MAX_POLLS = 30;

function stableJsonHash(value: unknown): string {
  return Crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/u, "");
}

function makeConnectionId(baseUrl: string, accessKeyId: string): OnshapeConnectionId {
  return `onshape_${Crypto.createHash("sha256")
    .update(`${normalizeBaseUrl(baseUrl)}:${accessKeyId.trim()}`)
    .digest("hex")
    .slice(0, 24)}` as OnshapeConnectionId;
}

function parseOnshapeUrl(rawUrl: string): ParsedOnshapeUrl {
  const url = new URL(rawUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const documentsIndex = parts.indexOf("documents");
  if (documentsIndex < 0 || parts[documentsIndex + 1] === undefined) {
    throw new Error("Expected an Onshape document or element URL.");
  }
  const documentId = parts[documentsIndex + 1]!;
  const maybeWvmKind = parts[documentsIndex + 2];
  const maybeWvmId = parts[documentsIndex + 3];
  if (maybeWvmKind !== "w" && maybeWvmKind !== "v" && maybeWvmKind !== "m") {
    throw new Error("Onshape URL must include a workspace, version, or microversion id.");
  }
  if (!maybeWvmId) {
    throw new Error("Onshape URL is missing the workspace, version, or microversion id.");
  }
  const elementIndex = parts.indexOf("e");
  return {
    baseUrl: `${url.protocol}//${url.host}`,
    documentId,
    wvmKind: maybeWvmKind,
    wvmId: maybeWvmId,
    elementId: elementIndex >= 0 ? (parts[elementIndex + 1] ?? null) : null,
  };
}

function getStringField(
  value: Record<string, unknown>,
  names: ReadonlyArray<string>,
): string | null {
  for (const name of names) {
    const field = value[name];
    if (typeof field === "string" && field.trim().length > 0) {
      return field;
    }
  }
  return null;
}

function normalizeElementType(value: unknown): OnshapeElementType {
  if (typeof value !== "string") {
    return "UNKNOWN";
  }
  const normalized = value.toUpperCase();
  if (
    normalized === "PARTSTUDIO" ||
    normalized === "ASSEMBLY" ||
    normalized === "BLOB" ||
    normalized === "APPLICATION" ||
    normalized === "FEATURESTUDIO"
  ) {
    return normalized;
  }
  return "UNKNOWN";
}

function makeDocumentUrl(reference: ParsedOnshapeUrl): string {
  return `${reference.baseUrl}/documents/${reference.documentId}/${reference.wvmKind}/${reference.wvmId}`;
}

function makeElementUrl(reference: ParsedOnshapeUrl, elementId: string): string {
  return `${makeDocumentUrl(reference)}/e/${elementId}`;
}

function publicOnshapeConnection(connection: OnshapeConnection): OnshapeConnection {
  return {
    ...connection,
    secretKeyConfigured: true,
  };
}

function expandHomePath(input: string): string {
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return `${OS.homedir()}/${input.slice(2)}`;
  }
  return input;
}

function getTranslationId(body: unknown): string | null {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const record = body as Record<string, unknown>;
  const candidates = [record.id, record.translationId, record.requestId];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return null;
}

function getTranslationStatus(body: unknown): string | null {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const value = (body as Record<string, unknown>).requestState;
  return typeof value === "string" ? value.toUpperCase() : null;
}

function getTranslationFailureReason(body: unknown): string | null {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const raw = (body as Record<string, unknown>).failureReason;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  return raw
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function getResultExternalDataId(body: unknown): string | null {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const record = body as Record<string, unknown>;
  const direct = record.resultExternalDataId;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct;
  }
  const ids = record.resultExternalDataIds;
  if (Array.isArray(ids)) {
    const first = ids.find((id) => typeof id === "string" && id.trim().length > 0);
    return typeof first === "string" ? first : null;
  }
  return null;
}

/** JSON body for STEP export via POST …/translations (retained for CAD-accurate workflows; previews use OBJ mesh). */
export function onshapeStepTranslationRequestBody(
  context: Pick<OnshapeContext, "entityKind" | "reference">,
): Record<string, unknown> {
  const { entityKind, reference } = context;
  const body: Record<string, unknown> = {
    formatName: "STEP",
    storeInDocument: false,
  };
  if (reference.partId) {
    body.partIds = reference.partId;
  }
  if (entityKind === "assembly") {
    // Fewer PRODUCT / assembly-instance records; web STEP parsers spend less time on metadata.
    body.flattenAssemblies = true;
    body.allowFaultyParts = true;
  }
  return body;
}

const PREVIEW_MESH_PARAMS = {
  // MEDIUM tends to preserve appearance / MTL data better than COARSE in Onshape OBJ exports.
  resolution: "MEDIUM",
  unit: "METER",
} as const;

/** JSON body for OBJ export via POST …/export/obj (fast WebGL preview; colors via MTL when present). */
export function onshapeObjExportRequestBody(
  context: Pick<OnshapeContext, "entityKind" | "reference">,
): Record<string, unknown> {
  const { entityKind, reference } = context;
  const body: Record<string, unknown> = {
    storeInDocument: false,
    notifyUser: false,
    excludeHiddenEntities: true,
    // Part studios: keep one OBJ per solid (usual expectation). Assemblies: ask Onshape to group so
    // the export can represent the full assembly instead of unrelated single-part OBJs; responses
    // may be ZIP archives — sync unpacks `onshape-sync/bundle/*` and picks the largest `.obj`.
    grouping: entityKind === "assembly",
    meshParams: PREVIEW_MESH_PARAMS,
  };
  if (reference.partId) {
    body.partIds = reference.partId;
  }
  return body;
}

function resolveExportTarget(context: OnshapeContext):
  | {
      readonly kind: "partstudio";
      readonly path: string;
      readonly body: Record<string, unknown>;
      readonly documentId: string;
    }
  | {
      readonly kind: "assembly";
      readonly path: string;
      readonly body: Record<string, unknown>;
      readonly documentId: string;
    } {
  const { reference } = context;
  if (!reference.documentId || !reference.wvmKind || !reference.wvmId || !reference.elementId) {
    throw new Error("Onshape sync requires document, workspace/version, and element ids.");
  }
  const documentId = encodeURIComponent(reference.documentId);
  const wvmId = encodeURIComponent(reference.wvmId);
  const elementId = encodeURIComponent(reference.elementId);
  // Preview pipeline: grouped OBJ mesh (MEDIUM balances appearance vs export time vs glTF on large assemblies).
  // For B-rep STEP instead, swap to: const body = onshapeStepTranslationRequestBody(context);
  const body = onshapeObjExportRequestBody(context);
  if (context.entityKind === "assembly") {
    return {
      kind: "assembly",
      path: `/api/v10/assemblies/d/${documentId}/${reference.wvmKind}/${wvmId}/e/${elementId}/export/obj`,
      body,
      documentId: reference.documentId,
    };
  }
  return {
    kind: "partstudio",
    path: `/api/v10/partstudios/d/${documentId}/${reference.wvmKind}/${wvmId}/e/${elementId}/export/obj`,
    body,
    documentId: reference.documentId,
  };
}

function mapDocumentListToEntities(input: {
  readonly connection: OnshapeConnection;
  readonly documents: unknown;
  readonly now: string;
}): ReadonlyArray<OnshapeEntity> {
  const documentsObject =
    input.documents !== null && typeof input.documents === "object"
      ? (input.documents as Record<string, unknown>)
      : {};
  const rawDocuments = Array.isArray(input.documents)
    ? input.documents
    : Array.isArray(documentsObject.items)
      ? documentsObject.items
      : Array.isArray(documentsObject.documents)
        ? documentsObject.documents
        : [];

  return rawDocuments.flatMap((entry): ReadonlyArray<OnshapeEntity> => {
    if (entry === null || typeof entry !== "object") {
      return [];
    }
    const document = entry as Record<string, unknown>;
    const documentId = getStringField(document, ["id", "documentId", "did"]);
    if (!documentId) {
      return [];
    }
    const name = getStringField(document, ["name", "documentName", "title"]) ?? documentId;
    const workspace =
      document.defaultWorkspace !== null && typeof document.defaultWorkspace === "object"
        ? (document.defaultWorkspace as Record<string, unknown>)
        : null;
    const wvmId =
      getStringField(document, ["workspaceId", "defaultWorkspaceId", "wvmId"]) ??
      (workspace ? getStringField(workspace, ["id", "workspaceId"]) : null);
    const url =
      getStringField(document, ["href", "url"]) ??
      (wvmId
        ? `${input.connection.baseUrl.replace(/\/+$/u, "")}/documents/${documentId}/w/${wvmId}`
        : `${input.connection.baseUrl.replace(/\/+$/u, "")}/documents/${documentId}`);

    return [
      {
        entityId: `${input.connection.connectionId}:document:${documentId}${wvmId ? `:w:${wvmId}` : ""}`,
        connectionId: input.connection.connectionId,
        parentEntityId: null,
        kind: "document",
        name,
        breadcrumb: [name],
        documentId,
        wvmKind: wvmId ? "w" : null,
        wvmId,
        elementId: null,
        elementType: null,
        partId: null,
        url,
        modifiedAt: getStringField(document, ["modifiedAt", "modifiedDate"]),
        indexedAt: input.now,
        metadataHash: stableJsonHash(document),
      },
    ];
  });
}

function mapContentsToEntities(input: {
  readonly connection: OnshapeConnection;
  readonly parsed: ParsedOnshapeUrl;
  readonly contents: unknown;
  readonly now: string;
}): ReadonlyArray<OnshapeEntity> {
  const contents = input.contents as Record<string, unknown>;
  const documentName =
    getStringField(contents, ["name", "documentName", "title"]) ?? input.parsed.documentId;
  const modifiedAt = getStringField(contents, ["modifiedAt", "modifiedDate"]);
  const documentEntityId = `${input.connection.connectionId}:document:${input.parsed.documentId}:${input.parsed.wvmKind}:${input.parsed.wvmId}`;
  const documentEntity: OnshapeEntity = {
    entityId: documentEntityId,
    connectionId: input.connection.connectionId,
    parentEntityId: null,
    kind: "document",
    name: documentName,
    breadcrumb: [documentName],
    documentId: input.parsed.documentId,
    wvmKind: input.parsed.wvmKind,
    wvmId: input.parsed.wvmId,
    elementId: null,
    elementType: null,
    partId: null,
    url: makeDocumentUrl(input.parsed),
    modifiedAt,
    indexedAt: input.now,
    metadataHash: stableJsonHash(contents),
  };

  const rawElements = Array.isArray(contents.elements)
    ? contents.elements
    : Array.isArray(contents.items)
      ? contents.items
      : [];

  const elementEntities = rawElements.flatMap((entry): ReadonlyArray<OnshapeEntity> => {
    if (entry === null || typeof entry !== "object") {
      return [];
    }
    const element = entry as Record<string, unknown>;
    const elementId = getStringField(element, ["id", "elementId", "eid"]);
    if (!elementId) {
      return [];
    }
    if (input.parsed.elementId !== null && elementId !== input.parsed.elementId) {
      return [];
    }
    const name = getStringField(element, ["name", "title"]) ?? elementId;
    const elementType = normalizeElementType(element.elementType ?? element.type);
    return [
      {
        entityId: `${input.connection.connectionId}:element:${input.parsed.documentId}:${input.parsed.wvmKind}:${input.parsed.wvmId}:${elementId}`,
        connectionId: input.connection.connectionId,
        parentEntityId: documentEntityId,
        kind: elementType === "ASSEMBLY" ? "assembly" : "element",
        name,
        breadcrumb: [documentName, name],
        documentId: input.parsed.documentId,
        wvmKind: input.parsed.wvmKind,
        wvmId: input.parsed.wvmId,
        elementId,
        elementType,
        partId: null,
        url: makeElementUrl(input.parsed, elementId),
        modifiedAt: getStringField(element, ["modifiedAt", "modifiedDate"]) ?? modifiedAt,
        indexedAt: input.now,
        metadataHash: stableJsonHash(element),
      },
    ];
  });

  return [documentEntity, ...elementEntities];
}

function mapPartsToEntities(input: {
  readonly connection: OnshapeConnection;
  readonly parsed: ParsedOnshapeUrl;
  readonly parts: unknown;
  readonly existingEntities: ReadonlyArray<OnshapeEntity>;
  readonly now: string;
}): ReadonlyArray<OnshapeEntity> {
  const rawParts = Array.isArray(input.parts) ? input.parts : [];
  const elementNameById = new Map(
    input.existingEntities
      .filter((entity) => entity.elementId !== null)
      .map((entity) => [entity.elementId, entity] as const),
  );
  return rawParts.flatMap((entry): ReadonlyArray<OnshapeEntity> => {
    if (entry === null || typeof entry !== "object") {
      return [];
    }
    const part = entry as Record<string, unknown>;
    const partId = getStringField(part, ["partId", "id"]);
    const elementId = getStringField(part, ["elementId", "eid"]);
    if (!partId || !elementId) {
      return [];
    }
    const parent = elementNameById.get(elementId);
    const name = getStringField(part, ["name", "partName"]) ?? partId;
    const parentEntityId =
      parent?.entityId ??
      `${input.connection.connectionId}:element:${input.parsed.documentId}:${input.parsed.wvmKind}:${input.parsed.wvmId}:${elementId}`;
    return [
      {
        entityId: `${input.connection.connectionId}:part:${input.parsed.documentId}:${input.parsed.wvmKind}:${input.parsed.wvmId}:${elementId}:${partId}`,
        connectionId: input.connection.connectionId,
        parentEntityId,
        kind: "part",
        name,
        breadcrumb: [...(parent?.breadcrumb ?? [input.parsed.documentId, elementId]), name],
        documentId: input.parsed.documentId,
        wvmKind: input.parsed.wvmKind,
        wvmId: input.parsed.wvmId,
        elementId,
        elementType: "PARTSTUDIO",
        partId,
        url: `${makeElementUrl(input.parsed, elementId)}?partId=${encodeURIComponent(partId)}`,
        modifiedAt: null,
        indexedAt: input.now,
        metadataHash: stableJsonHash(part),
      },
    ];
  });
}

const makeOnshapeWorkspace = Effect.gen(function* () {
  const repository = yield* OnshapeIndexRepository;
  const secretStore = yield* ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const resolveSyncOutputPath = (cwd: string) => {
    const workspaceRoot = path.resolve(expandHomePath(cwd));
    const outputPath = path.resolve(workspaceRoot, SYNC_RELATIVE_PATH);
    const relative = path.relative(workspaceRoot, outputPath);
    if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Onshape sync output path escaped the workspace root.");
    }
    return { workspaceRoot, path: outputPath };
  };

  const getSecret = (connectionId: string) =>
    secretStore.get(`onshape-${connectionId}`).pipe(
      Effect.flatMap((secret) =>
        secret === null
          ? Effect.fail(
              new OnshapeWorkspaceFailure({
                message: "Onshape secret key is not configured.",
              }),
            )
          : Effect.succeed(new TextDecoder().decode(secret)),
      ),
    );

  const signRequest = (input: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly query: string;
    readonly accessKeyId: string;
    readonly secretKey: string;
    readonly body?: string;
  }) => {
    // @effect-diagnostics-next-line globalDate:off
    const date = new Date().toUTCString();
    const nonce = Crypto.randomBytes(16).toString("hex");
    const contentType = "application/json";
    const signingString = [
      input.method,
      nonce,
      date,
      contentType,
      input.path,
      input.query,
      input.body ?? "",
    ]
      .join("\n")
      .toLowerCase();
    const signature = Crypto.createHmac("sha256", input.secretKey)
      .update(signingString)
      .digest("base64");
    return {
      Authorization: `On ${input.accessKeyId.trim()}:HmacSHA256:${signature}`,
      Date: date,
      "On-Nonce": nonce,
      Accept: contentType,
      "Content-Type": contentType,
    };
  };

  const requestJson = (input: {
    readonly connection: OnshapeConnection;
    readonly secretKey: string;
    readonly method?: "GET" | "POST";
    readonly path: string;
    readonly searchParams?: Readonly<Record<string, string>>;
    readonly body?: Record<string, unknown>;
    readonly endpoint: string;
  }) =>
    Effect.gen(function* () {
      const url = new URL(`${input.connection.baseUrl.replace(/\/+$/u, "")}${input.path}`);
      for (const [key, value] of Object.entries(input.searchParams ?? {})) {
        url.searchParams.set(key, value);
      }
      const method = input.method ?? "GET";
      const headers = signRequest({
        method,
        path: url.pathname,
        query: url.search.length > 0 ? url.search.slice(1) : "",
        accessKeyId: input.connection.accessKeyId,
        secretKey: input.secretKey,
      });
      const request =
        method === "POST"
          ? HttpClientRequest.post(url.toString()).pipe(
              HttpClientRequest.setHeaders(headers),
              input.body !== undefined
                ? HttpClientRequest.bodyJsonUnsafe(input.body)
                : (request) => request,
              HttpClientRequest.acceptJson,
            )
          : HttpClientRequest.get(url.toString()).pipe(
              HttpClientRequest.setHeaders(headers),
              HttpClientRequest.acceptJson,
            );
      const response = yield* httpClient.execute(request);
      const metrics: RequestMetrics = {
        endpoint: input.endpoint,
        status: response.status,
        rateLimitRemaining: response.headers["x-rate-limit-remaining"] ?? null,
        retryAfter: response.headers["retry-after"] ?? null,
      };
      if (response.status === 429) {
        return yield* new OnshapeWorkspaceFailure({
          message: "Onshape rate limit reached.",
          cause: metrics,
        });
      }
      if (response.status < 200 || response.status >= 300) {
        const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
        return yield* new OnshapeWorkspaceFailure({
          message: `Onshape request failed (${response.status}): ${body}`,
          cause: metrics,
        });
      }
      const jsonBody = yield* response.json.pipe(
        Effect.mapError(
          () =>
            new OnshapeWorkspaceFailure({
              message: "Onshape response was not valid JSON.",
              cause: metrics,
            }),
        ),
      );
      return { body: jsonBody, metrics };
    });

  const requestBinary = (input: {
    readonly connection: OnshapeConnection;
    readonly secretKey: string;
    readonly path: string;
    readonly endpoint: string;
  }) =>
    Effect.gen(function* () {
      const url = new URL(`${input.connection.baseUrl.replace(/\/+$/u, "")}${input.path}`);
      const headers = signRequest({
        method: "GET",
        path: url.pathname,
        query: url.search.length > 0 ? url.search.slice(1) : "",
        accessKeyId: input.connection.accessKeyId,
        secretKey: input.secretKey,
      });
      const response = yield* httpClient.execute(
        HttpClientRequest.get(url.toString()).pipe(HttpClientRequest.setHeaders(headers)),
      );
      if (response.status === 429) {
        return yield* new OnshapeWorkspaceFailure({
          message: "Onshape rate limit reached.",
          cause: {
            endpoint: input.endpoint,
            status: response.status,
            rateLimitRemaining: response.headers["x-rate-limit-remaining"] ?? null,
            retryAfter: response.headers["retry-after"] ?? null,
          } satisfies RequestMetrics,
        });
      }
      if (response.status < 200 || response.status >= 300) {
        const responseBody = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
        return yield* new OnshapeWorkspaceFailure({
          message: `Onshape download failed (${response.status}): ${responseBody}`,
        });
      }
      return yield* response.arrayBuffer.pipe(Effect.map((buffer) => new Uint8Array(buffer)));
    });

  const saveRun = (run: OnshapeIndexRun) => repository.upsertIndexRun(run).pipe(Effect.as(run));

  const indexParsedUrl = (input: {
    readonly connection: OnshapeConnection;
    readonly secretKey: string;
    readonly parsed: ParsedOnshapeUrl;
    readonly includeParts: boolean;
  }) =>
    Effect.gen(function* () {
      const startedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const endpointCounts: Record<string, number> = {};
      const plannedRequests = input.includeParts ? 2 : 1;
      const runBase = {
        runId: `run_${Crypto.randomUUID()}`,
        connectionId: input.connection.connectionId,
        scopeEntityId: null,
        plannedRequests,
        skippedRequests: 0,
        rateLimitedRequests: 0,
        endpointCounts,
        startedAt,
        finishedAt: null,
        nextAllowedAt: null,
        lastError: null,
      } satisfies Omit<OnshapeIndexRun, "status" | "completedRequests">;

      yield* saveRun({ ...runBase, status: "indexing", completedRequests: 0 });

      const contentsResponse = yield* requestJson({
        connection: input.connection,
        secretKey: input.secretKey,
        path: `/api/v10/documents/d/${encodeURIComponent(input.parsed.documentId)}/${input.parsed.wvmKind}/${encodeURIComponent(input.parsed.wvmId)}/contents`,
        ...(input.parsed.elementId !== null
          ? { searchParams: { elementId: input.parsed.elementId } }
          : {}),
        endpoint: "GetDocumentContents",
      });
      endpointCounts.GetDocumentContents = (endpointCounts.GetDocumentContents ?? 0) + 1;

      const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const contentEntities = mapContentsToEntities({
        connection: input.connection,
        parsed: input.parsed,
        contents: contentsResponse.body,
        now,
      });

      let entities = contentEntities;
      let completedRequests = 1;

      if (input.includeParts) {
        const partsResponse = yield* requestJson({
          connection: input.connection,
          secretKey: input.secretKey,
          path: `/api/v10/parts/d/${encodeURIComponent(input.parsed.documentId)}/${input.parsed.wvmKind}/${encodeURIComponent(input.parsed.wvmId)}`,
          endpoint: "GetPartsWMV",
        });
        endpointCounts.GetPartsWMV = (endpointCounts.GetPartsWMV ?? 0) + 1;
        completedRequests += 1;
        entities = [
          ...entities,
          ...mapPartsToEntities({
            connection: input.connection,
            parsed: input.parsed,
            parts: partsResponse.body,
            existingEntities: contentEntities,
            now,
          }),
        ];
      }

      yield* repository.upsertEntities(entities);
      const run = yield* saveRun({
        ...runBase,
        status: "ready",
        completedRequests,
        endpointCounts,
        finishedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      });
      return { run, entities };
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const startedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          const maybeMetrics =
            error instanceof OnshapeWorkspaceFailure &&
            error.cause !== undefined &&
            typeof error.cause === "object" &&
            error.cause !== null &&
            "status" in error.cause
              ? (error.cause as RequestMetrics)
              : undefined;
          const retryAfter = maybeMetrics?.retryAfter;
          let nextAllowedAt: string | null = null;
          if (retryAfter !== undefined && retryAfter !== null) {
            // @effect-diagnostics-next-line globalDateInEffect:off
            const retryDate = new Date(Date.now() + Number.parseInt(retryAfter, 10) * 1_000);
            nextAllowedAt = retryDate.toISOString();
          }
          yield* saveRun({
            runId: `run_${Crypto.randomUUID()}`,
            connectionId: input.connection.connectionId,
            scopeEntityId: null,
            status: maybeMetrics?.status === 429 ? "rateLimited" : "error",
            plannedRequests: input.includeParts ? 2 : 1,
            completedRequests: 0,
            skippedRequests: 0,
            rateLimitedRequests: maybeMetrics?.status === 429 ? 1 : 0,
            endpointCounts: maybeMetrics ? { [maybeMetrics.endpoint]: 1 } : {},
            startedAt,
            finishedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
            nextAllowedAt,
            lastError: error.message,
          });
          return yield* error;
        }),
      ),
    );

  const listConnections: OnshapeWorkspaceShape["listConnections"] = () =>
    repository.listConnections().pipe(
      Effect.map((connections) => ({
        connections: connections.map(publicOnshapeConnection),
      })),
    );

  const setupConnection: OnshapeWorkspaceShape["setupConnection"] = (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const connectionId = makeConnectionId(input.baseUrl, input.accessKeyId);
      const accessKeyId = input.accessKeyId.trim();
      const secretKey = input.secretKey.trim();
      const connection = {
        connectionId,
        displayName: input.displayName.trim(),
        baseUrl: normalizeBaseUrl(input.baseUrl),
        accessKeyId,
        secretKeyConfigured: true,
        secretKeyCiphertext: "server-secret-store:onshape",
        createdAt: now,
        updatedAt: now,
      };
      yield* secretStore.set(`onshape-${connectionId}`, textEncoder.encode(secretKey));
      yield* repository.upsertConnection(connection);
      const persistedSecretKey = yield* getSecret(connectionId);
      yield* requestJson({
        connection,
        secretKey: persistedSecretKey,
        path: "/api/v10/documents",
        searchParams: { limit: "1" },
        endpoint: "ValidateCredentials",
      });
      return { connection: publicOnshapeConnection(connection) };
    });

  const importUrl: OnshapeWorkspaceShape["importUrl"] = (input) =>
    Effect.gen(function* () {
      const connection = yield* repository.getConnection(input.connectionId);
      if (Option.isNone(connection)) {
        return yield* new OnshapeWorkspaceFailure({
          message: `Unknown Onshape connection '${input.connectionId}'.`,
        });
      }
      const parsed = parseOnshapeUrl(input.url);
      const secretKey = yield* getSecret(input.connectionId);
      return yield* indexParsedUrl({
        connection: publicOnshapeConnection(connection.value),
        secretKey,
        parsed: { ...parsed, baseUrl: connection.value.baseUrl },
        includeParts: input.includeParts,
      });
    });

  const refreshIndex: OnshapeWorkspaceShape["refreshIndex"] = (input) =>
    Effect.gen(function* () {
      if (input.scopeEntityId === undefined) {
        const connection = yield* repository.getConnection(input.connectionId);
        if (Option.isNone(connection)) {
          return yield* new OnshapeWorkspaceFailure({
            message: `Unknown Onshape connection '${input.connectionId}'.`,
          });
        }
        const publicPersistedConnection = publicOnshapeConnection(connection.value);
        const secretKey = yield* getSecret(input.connectionId);
        const startedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const runBase = {
          runId: `run_${Crypto.randomUUID()}`,
          connectionId: input.connectionId,
          scopeEntityId: null,
          plannedRequests: 1,
          skippedRequests: 0,
          rateLimitedRequests: 0,
          endpointCounts: {},
          startedAt,
          finishedAt: null,
          nextAllowedAt: null,
          lastError: null,
        } satisfies Omit<OnshapeIndexRun, "status" | "completedRequests">;
        yield* saveRun({ ...runBase, status: "indexing", completedRequests: 0 });
        const response = yield* requestJson({
          connection: publicPersistedConnection,
          secretKey,
          path: "/api/v10/documents",
          searchParams: { limit: DEFAULT_DOCUMENT_LIST_LIMIT },
          endpoint: "ListDocuments",
        });
        const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const entities = mapDocumentListToEntities({
          connection: publicPersistedConnection,
          documents: response.body,
          now,
        });
        yield* repository.upsertEntities(entities);
        const run = yield* saveRun({
          ...runBase,
          status: "ready",
          completedRequests: 1,
          endpointCounts: { ListDocuments: 1 },
          finishedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        });
        return { run, entities };
      }
      const entity = yield* repository.getEntity(input.scopeEntityId);
      if (Option.isNone(entity) || entity.value.url === null) {
        return yield* new OnshapeWorkspaceFailure({
          message: "Selected Onshape entity cannot be refreshed by URL.",
        });
      }
      return yield* importUrl({
        connectionId: input.connectionId,
        url: entity.value.url,
        includeParts: entity.value.kind === "part",
      });
    });

  const searchIndex: OnshapeWorkspaceShape["searchIndex"] = (input) =>
    repository
      .searchEntities({
        ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
        query: input.query,
        limit: input.limit,
      })
      .pipe(Effect.map((entities) => ({ entities: Array.from(entities) })));

  const syncProject: OnshapeWorkspaceShape["syncProject"] = (input) =>
    Effect.gen(function* () {
      const connection = yield* repository.getConnection(input.context.connectionId);
      if (Option.isNone(connection)) {
        return yield* new OnshapeWorkspaceFailure({
          message: `Unknown Onshape connection '${input.context.connectionId}'.`,
        });
      }

      const target = resolveExportTarget(input.context);
      const secretKey = yield* getSecret(input.context.connectionId);
      const persistedConnection = publicOnshapeConnection(connection.value);
      const translation = yield* requestJson({
        connection: persistedConnection,
        secretKey,
        method: "POST",
        path: target.path,
        body: target.body,
        endpoint: `${target.kind}.CreateTranslation`,
      });
      const translationId = getTranslationId(translation.body);
      if (!translationId) {
        return yield* new OnshapeWorkspaceFailure({
          message: "Onshape did not return a translation id for OBJ export.",
          cause: translation.body,
        });
      }

      let statusBody = translation.body;
      for (let attempt = 0; attempt < TRANSLATION_MAX_POLLS; attempt += 1) {
        const status = getTranslationStatus(statusBody);
        if (status === "DONE") {
          break;
        }
        if (status === "FAILED" || status === "CANCELLED") {
          const detail = getTranslationFailureReason(statusBody);
          return yield* new OnshapeWorkspaceFailure({
            message: detail
              ? `Onshape OBJ export ${status.toLowerCase()}: ${detail}`
              : `Onshape OBJ export ${status.toLowerCase()}.`,
            cause: statusBody,
          });
        }
        yield* Effect.sleep(TRANSLATION_POLL_INTERVAL);
        const nextStatus = yield* requestJson({
          connection: persistedConnection,
          secretKey,
          path: `/api/v10/translations/${encodeURIComponent(translationId)}`,
          endpoint: `${target.kind}.GetTranslationStatus`,
        });
        statusBody = nextStatus.body;
      }

      if (getTranslationStatus(statusBody) !== "DONE") {
        return yield* new OnshapeWorkspaceFailure({
          message: "Onshape OBJ export timed out before the translated file was ready.",
          cause: statusBody,
        });
      }

      const externalDataId = getResultExternalDataId(statusBody);
      if (!externalDataId) {
        return yield* new OnshapeWorkspaceFailure({
          message: "Onshape OBJ export completed without a downloadable file id.",
          cause: statusBody,
        });
      }

      const bytes = yield* requestBinary({
        connection: persistedConnection,
        secretKey,
        path: `/api/v10/documents/d/${encodeURIComponent(target.documentId)}/externaldata/${encodeURIComponent(externalDataId)}`,
        endpoint: `${target.kind}.DownloadTranslation`,
      });
      const payload = compactDownloadedBytes(bytes);
      yield* Effect.logInfo("onshape.syncProject.download", {
        byteLength: payload.length,
        headHex: formatBytesHeadHex(payload),
        documentId: target.documentId,
        externalDataId,
      });
      const output = yield* Effect.try({
        try: () => resolveSyncOutputPath(input.cwd),
        catch: (cause) =>
          new OnshapeWorkspaceFailure({
            message: cause instanceof Error ? cause.message : "Failed to resolve sync output path.",
            cause,
          }),
      });
      const syncRootResolved = path.resolve(path.join(output.workspaceRoot, CAD_SYNC_DIRECTORY));
      const bundleDirResolved = path.resolve(
        path.join(output.workspaceRoot, CAD_SYNC_DIRECTORY, "bundle"),
      );
      const removeIfPresent = (absolutePath: string) =>
        fileSystem
          .remove(absolutePath, { recursive: true, force: true })
          .pipe(Effect.catch(() => Effect.void));
      const isWithinSyncTree = (absolutePath: string) => {
        const resolved = path.resolve(absolutePath);
        return (
          resolved === syncRootResolved || resolved.startsWith(`${syncRootResolved}${path.sep}`)
        );
      };
      const mapFsFailure = (cause: { message: string }) =>
        new OnshapeWorkspaceFailure({
          message: cause.message,
          cause,
        });

      const extracted = isZipArchive(payload) ? tryExtractObjBundle(payload) : null;
      if (extracted === null && isZipArchive(payload)) {
        return yield* new OnshapeWorkspaceFailure({
          message:
            "Onshape returned a ZIP mesh export, but it could not be expanded to .obj files. Try syncing again or check the Onshape translation in the Onshape UI.",
        });
      }

      if (extracted !== null) {
        yield* removeIfPresent(bundleDirResolved);
        yield* removeIfPresent(output.path);

        for (const file of extracted.files) {
          const destAbs = path.resolve(path.join(output.workspaceRoot, file.relativePath));
          if (!isWithinSyncTree(destAbs)) {
            return yield* new OnshapeWorkspaceFailure({
              message: "Onshape OBJ export contained a path outside the sync directory.",
            });
          }
        }

        for (const file of extracted.files) {
          const destAbs = path.resolve(path.join(output.workspaceRoot, file.relativePath));
          yield* fileSystem
            .makeDirectory(path.dirname(destAbs), { recursive: true })
            .pipe(Effect.mapError(mapFsFailure));
          yield* fileSystem.writeFile(destAbs, file.bytes).pipe(Effect.mapError(mapFsFailure));
        }

        const primaryAbs = path.resolve(
          path.join(output.workspaceRoot, extracted.primaryRelativePath),
        );
        return {
          relativePath: extracted.primaryRelativePath,
          absolutePath: primaryAbs,
          syncedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
          format: "obj",
        };
      }

      if (!looksLikeObjText(payload)) {
        return yield* new OnshapeWorkspaceFailure({
          message:
            "Onshape download was not valid Wavefront OBJ text (and was not a recognized OBJ zip). headHex=" +
            formatBytesHeadHex(payload) +
            ". Delete onshape-sync artifacts and sync again after upgrading the server.",
        });
      }

      yield* removeIfPresent(bundleDirResolved);

      yield* fileSystem
        .makeDirectory(path.dirname(output.path), { recursive: true })
        .pipe(Effect.mapError(mapFsFailure));
      yield* fileSystem.writeFile(output.path, payload).pipe(Effect.mapError(mapFsFailure));

      return {
        relativePath: SYNC_RELATIVE_PATH,
        absolutePath: output.path,
        syncedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        format: "obj",
      };
    });

  return {
    listConnections,
    setupConnection,
    importUrl,
    refreshIndex,
    searchIndex,
    syncProject,
  } satisfies OnshapeWorkspaceShape;
});

export const OnshapeWorkspaceLive = Layer.effect(OnshapeWorkspace, makeOnshapeWorkspace);
