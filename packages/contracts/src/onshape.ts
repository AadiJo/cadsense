import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

const ONshapeId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const OnshapeUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(2_000));

export const OnshapeConnectionId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type OnshapeConnectionId = typeof OnshapeConnectionId.Type;

export const OnshapeEntityId = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
export type OnshapeEntityId = typeof OnshapeEntityId.Type;

export const OnshapeEntityKind = Schema.Literals([
  "folder",
  "document",
  "element",
  "part",
  "assembly",
]);
export type OnshapeEntityKind = typeof OnshapeEntityKind.Type;

export const OnshapeElementType = Schema.Literals([
  "PARTSTUDIO",
  "ASSEMBLY",
  "BLOB",
  "APPLICATION",
  "FEATURESTUDIO",
  "UNKNOWN",
]);
export type OnshapeElementType = typeof OnshapeElementType.Type;

export const OnshapeWvmKind = Schema.Literals(["w", "v", "m"]);
export type OnshapeWvmKind = typeof OnshapeWvmKind.Type;

export const OnshapeReference = Schema.Struct({
  baseUrl: TrimmedNonEmptyString,
  documentId: Schema.optional(ONshapeId),
  wvmKind: Schema.optional(OnshapeWvmKind),
  wvmId: Schema.optional(ONshapeId),
  elementId: Schema.optional(ONshapeId),
  partId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  folderId: Schema.optional(ONshapeId),
  projectId: Schema.optional(ONshapeId),
  url: Schema.optional(OnshapeUrl),
});
export type OnshapeReference = typeof OnshapeReference.Type;

export const OnshapeContext = Schema.Struct({
  connectionId: OnshapeConnectionId,
  entityId: OnshapeEntityId,
  entityKind: OnshapeEntityKind,
  name: TrimmedNonEmptyString,
  breadcrumb: Schema.Array(TrimmedNonEmptyString),
  reference: OnshapeReference,
  lastSyncedAt: Schema.optionalKey(IsoDateTime),
  lastSyncedRelativePath: Schema.optionalKey(TrimmedNonEmptyString),
  lastSyncedFormat: Schema.optionalKey(TrimmedNonEmptyString),
  lastSyncError: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
});
export type OnshapeContext = typeof OnshapeContext.Type;

export const ExternalProjectContext = Schema.Struct({
  provider: Schema.Literal("onshape"),
  onshape: OnshapeContext,
});
export type ExternalProjectContext = typeof ExternalProjectContext.Type;

export const ExternalThreadContext = Schema.Struct({
  provider: Schema.Literal("onshape"),
  onshape: OnshapeContext,
});
export type ExternalThreadContext = typeof ExternalThreadContext.Type;

export const OnshapeConnection = Schema.Struct({
  connectionId: OnshapeConnectionId,
  displayName: TrimmedNonEmptyString,
  baseUrl: TrimmedNonEmptyString,
  accessKeyId: TrimmedNonEmptyString,
  secretKeyConfigured: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OnshapeConnection = typeof OnshapeConnection.Type;

export const OnshapeSyncStatus = Schema.Literals([
  "idle",
  "indexing",
  "ready",
  "rateLimited",
  "error",
]);
export type OnshapeSyncStatus = typeof OnshapeSyncStatus.Type;

export const OnshapeIndexRun = Schema.Struct({
  runId: TrimmedNonEmptyString,
  connectionId: OnshapeConnectionId,
  scopeEntityId: Schema.NullOr(OnshapeEntityId),
  status: OnshapeSyncStatus,
  plannedRequests: NonNegativeInt,
  completedRequests: NonNegativeInt,
  skippedRequests: NonNegativeInt,
  rateLimitedRequests: NonNegativeInt,
  endpointCounts: Schema.Record(Schema.String, NonNegativeInt),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  nextAllowedAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
});
export type OnshapeIndexRun = typeof OnshapeIndexRun.Type;

export const OnshapeEntity = Schema.Struct({
  entityId: OnshapeEntityId,
  connectionId: OnshapeConnectionId,
  parentEntityId: Schema.NullOr(OnshapeEntityId),
  kind: OnshapeEntityKind,
  name: TrimmedNonEmptyString,
  breadcrumb: Schema.Array(TrimmedNonEmptyString),
  documentId: Schema.NullOr(ONshapeId),
  wvmKind: Schema.NullOr(OnshapeWvmKind),
  wvmId: Schema.NullOr(ONshapeId),
  elementId: Schema.NullOr(ONshapeId),
  elementType: Schema.NullOr(OnshapeElementType),
  partId: Schema.NullOr(Schema.String),
  url: Schema.NullOr(OnshapeUrl),
  modifiedAt: Schema.NullOr(IsoDateTime),
  indexedAt: IsoDateTime,
  metadataHash: Schema.NullOr(Schema.String),
});
export type OnshapeEntity = typeof OnshapeEntity.Type;

export const OnshapeThreadContext = Schema.Struct({
  threadId: ThreadId,
  projectId: Schema.NullOr(ProjectId),
  context: OnshapeContext,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OnshapeThreadContext = typeof OnshapeThreadContext.Type;

export const OnshapeSetupConnectionInput = Schema.Struct({
  displayName: TrimmedNonEmptyString,
  baseUrl: TrimmedNonEmptyString,
  accessKeyId: TrimmedNonEmptyString,
  secretKey: TrimmedNonEmptyString,
});
export type OnshapeSetupConnectionInput = typeof OnshapeSetupConnectionInput.Type;

export const OnshapeSetupConnectionResult = Schema.Struct({
  connection: OnshapeConnection,
});
export type OnshapeSetupConnectionResult = typeof OnshapeSetupConnectionResult.Type;

export const OnshapeListConnectionsResult = Schema.Struct({
  connections: Schema.Array(OnshapeConnection),
});
export type OnshapeListConnectionsResult = typeof OnshapeListConnectionsResult.Type;

export const OnshapeImportUrlInput = Schema.Struct({
  connectionId: OnshapeConnectionId,
  url: OnshapeUrl,
  includeParts: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type OnshapeImportUrlInput = typeof OnshapeImportUrlInput.Type;

export const OnshapeRefreshIndexInput = Schema.Struct({
  connectionId: OnshapeConnectionId,
  scopeEntityId: Schema.optional(OnshapeEntityId),
});
export type OnshapeRefreshIndexInput = typeof OnshapeRefreshIndexInput.Type;

export const OnshapeIndexResult = Schema.Struct({
  run: OnshapeIndexRun,
  entities: Schema.Array(OnshapeEntity),
});
export type OnshapeIndexResult = typeof OnshapeIndexResult.Type;

export const OnshapeSearchIndexInput = Schema.Struct({
  connectionId: Schema.optional(OnshapeConnectionId),
  query: Schema.String.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(100)),
});
export type OnshapeSearchIndexInput = typeof OnshapeSearchIndexInput.Type;

export const OnshapeSearchIndexResult = Schema.Struct({
  entities: Schema.Array(OnshapeEntity),
});
export type OnshapeSearchIndexResult = typeof OnshapeSearchIndexResult.Type;

export const OnshapeSyncProjectInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  context: OnshapeContext,
});
export type OnshapeSyncProjectInput = typeof OnshapeSyncProjectInput.Type;

export const OnshapeSyncProjectResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  absolutePath: TrimmedNonEmptyString,
  syncedAt: IsoDateTime,
  format: TrimmedNonEmptyString,
});
export type OnshapeSyncProjectResult = typeof OnshapeSyncProjectResult.Type;

export const OnshapeListSyncedCadFilesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  preferredRelativePath: Schema.optionalKey(TrimmedNonEmptyString),
});
export type OnshapeListSyncedCadFilesInput = typeof OnshapeListSyncedCadFilesInput.Type;

export const OnshapeSyncedCadFile = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  isPreferred: Schema.Boolean,
  sizeBytes: Schema.optionalKey(NonNegativeInt),
});
export type OnshapeSyncedCadFile = typeof OnshapeSyncedCadFile.Type;

export const OnshapeListSyncedCadFilesResult = Schema.Struct({
  files: Schema.Array(OnshapeSyncedCadFile),
});
export type OnshapeListSyncedCadFilesResult = typeof OnshapeListSyncedCadFilesResult.Type;

export const CadView = Schema.Literals([
  "top",
  "bottom",
  "front",
  "back",
  "left",
  "right",
  "isometric",
  "top-close-up",
  "bottom-close-up",
  "front-close-up",
  "back-close-up",
  "left-close-up",
  "right-close-up",
  "isometric-close-up",
]);
export type CadView = typeof CadView.Type;

export const CadSetViewInput = Schema.Struct({
  threadId: ThreadId,
  view: CadView,
  fit: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type CadSetViewInput = typeof CadSetViewInput.Type;

export const CadCameraVector = Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]);
export type CadCameraVector = typeof CadCameraVector.Type;

export const CadSetCameraInput = Schema.Struct({
  threadId: ThreadId,
  direction: CadCameraVector,
  up: Schema.optionalKey(CadCameraVector),
  fit: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  closeUp: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type CadSetCameraInput = typeof CadSetCameraInput.Type;

export const CadComponentVisibilityInput = Schema.Struct({
  threadId: ThreadId,
  componentId: TrimmedNonEmptyString,
  visible: Schema.Boolean,
});
export type CadComponentVisibilityInput = typeof CadComponentVisibilityInput.Type;

export const CadExplodedViewInput = Schema.Struct({
  threadId: ThreadId,
  exploded: Schema.Boolean,
});
export type CadExplodedViewInput = typeof CadExplodedViewInput.Type;

export const CadZoomToFitInput = Schema.Struct({
  threadId: ThreadId,
});
export type CadZoomToFitInput = typeof CadZoomToFitInput.Type;

export const CadHierarchyRequestInput = Schema.Struct({
  threadId: ThreadId,
});
export type CadHierarchyRequestInput = typeof CadHierarchyRequestInput.Type;

export const CadHierarchyComponent = Schema.Struct({
  id: TrimmedNonEmptyString,
  parentId: Schema.optional(TrimmedNonEmptyString),
  name: TrimmedNonEmptyString,
  kind: Schema.Literals(["assembly", "part"]),
  hasChildren: Schema.Boolean,
  visible: Schema.Boolean,
});
export type CadHierarchyComponent = typeof CadHierarchyComponent.Type;

export const CadHierarchyBrowserRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
});
export type CadHierarchyBrowserRequest = typeof CadHierarchyBrowserRequest.Type;

export const CadHierarchyUploadInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  components: Schema.Array(CadHierarchyComponent),
});
export type CadHierarchyUploadInput = typeof CadHierarchyUploadInput.Type;

export const CadHierarchyResult = Schema.Struct({
  components: Schema.Array(CadHierarchyComponent),
});
export type CadHierarchyResult = typeof CadHierarchyResult.Type;

export const CadControlInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("set-view"),
    ...CadSetViewInput.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("set-camera"),
    ...CadSetCameraInput.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("set-component-visibility"),
    ...CadComponentVisibilityInput.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("set-exploded"),
    ...CadExplodedViewInput.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("zoom-to-fit"),
    ...CadZoomToFitInput.fields,
  }),
]);
export type CadControlInput = typeof CadControlInput.Type;

export const CadViewCommand = Schema.Union([
  Schema.Struct({
    commandId: TrimmedNonEmptyString,
    type: Schema.Literal("set-view"),
    threadId: ThreadId,
    view: CadView,
    fit: Schema.Boolean,
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    commandId: TrimmedNonEmptyString,
    type: Schema.Literal("set-camera"),
    threadId: ThreadId,
    direction: CadCameraVector,
    up: Schema.optionalKey(CadCameraVector),
    fit: Schema.Boolean,
    closeUp: Schema.Boolean,
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    commandId: TrimmedNonEmptyString,
    type: Schema.Literal("set-component-visibility"),
    threadId: ThreadId,
    componentId: TrimmedNonEmptyString,
    visible: Schema.Boolean,
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    commandId: TrimmedNonEmptyString,
    type: Schema.Literal("set-exploded"),
    threadId: ThreadId,
    exploded: Schema.Boolean,
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    commandId: TrimmedNonEmptyString,
    type: Schema.Literal("zoom-to-fit"),
    threadId: ThreadId,
    createdAt: IsoDateTime,
  }),
]);
export type CadViewCommand = typeof CadViewCommand.Type;

/** Pushed to the browser so the CAD panel can render and upload a PNG. */
export const CadScreenshotBrowserRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  view: Schema.optional(CadView),
  fit: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  suggestedBaseName: Schema.optional(TrimmedString),
});
export type CadScreenshotBrowserRequest = typeof CadScreenshotBrowserRequest.Type;

/** MCP HTTP POST body for `/api/cad/screenshot-capture` (Codex MCP child). */
export const CadScreenshotMcpCaptureInput = Schema.Struct({
  threadId: ThreadId,
  exportRoot: TrimmedNonEmptyString,
  view: Schema.optional(CadView),
  fit: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  suggestedBaseName: Schema.optional(TrimmedString),
});
export type CadScreenshotMcpCaptureInput = typeof CadScreenshotMcpCaptureInput.Type;

export const CadScreenshotCaptureHttpResult = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  absolutePath: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString,
});
export type CadScreenshotCaptureHttpResult = typeof CadScreenshotCaptureHttpResult.Type;

export const CadScreenshotUploadInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  pngBase64: TrimmedNonEmptyString,
});
export type CadScreenshotUploadInput = typeof CadScreenshotUploadInput.Type;

export const CadScreenshotUploadResult = Schema.Struct({
  absolutePath: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString,
});
export type CadScreenshotUploadResult = typeof CadScreenshotUploadResult.Type;

export class OnshapeRpcError extends Schema.TaggedErrorClass<OnshapeRpcError>()("OnshapeRpcError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}
