import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Path from "effect/Path";
import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  type AuthAccessStreamEvent,
  AuthSessionId,
  CommandId,
  EventId,
  type OrchestrationCommand,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  type CadReviewStatus,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  OrchestrationReplayEventsError,
  FilesystemBrowseError,
  OnshapeRpcError,
  MechbaseRpcError,
  type OnshapeListSyncedCadFilesResult,
  type OnshapeSyncedCadFile,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@cadsense/contracts";
import {
  CAD_SYNC_DIRECTORY,
  DEFAULT_ONSHAPE_SYNC_MODEL_PATH,
  getCadModelExtension,
  isObjPreviewCompanionPath,
  isOnshapeSyncRelativePath,
  isSupportedCadModelPath,
  OBJ_MTLLIB_SCAN_MAX_BYTES,
  parseObjMtllibFilenames,
  parseMtlReferencedAssetFilenames,
} from "@cadsense/shared/cad";
import { clamp } from "effect/Number";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { ServerConfig } from "./config.ts";
import { Keybindings } from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import { normalizeDispatchCommand } from "./orchestration/Normalizer.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import { ServerLifecycleEvents } from "./serverLifecycleEvents.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";
import { redactServerSettingsForClient, ServerSettingsService } from "./serverSettings.ts";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths.ts";
import { VcsStatusBroadcaster } from "./vcs/VcsStatusBroadcaster.ts";
import { VcsProvisioningService } from "./vcs/VcsProvisioningService.ts";
import { GitWorkflowService } from "./git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "./project/Services/ProjectSetupScriptRunner.ts";
import { RepositoryIdentityResolver } from "./project/Services/RepositoryIdentityResolver.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as SourceControlDiscoveryLayer from "./sourceControl/SourceControlDiscovery.ts";
import { SourceControlRepositoryService } from "./sourceControl/SourceControlRepositoryService.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import { OnshapeWorkspace } from "./onshape/Services/OnshapeWorkspace.ts";
import { OnshapeWorkspaceLive } from "./onshape/Layers/OnshapeWorkspace.ts";
import { OnshapeIndexRepositoryLive } from "./persistence/Layers/OnshapeIndex.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { ServerSecretStore } from "./auth/Services/ServerSecretStore.ts";
import { MECHBASE_API_KEY_SECRET_NAME, validateMechbaseApiKey } from "./mechbase/MechbaseApi.ts";
import { decodeMechbaseApiKey, encodeMechbaseApiKey } from "./mechbase/MechbaseConnection.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import {
  BootstrapCredentialService,
  type BootstrapCredentialChange,
} from "./auth/Services/BootstrapCredentialService.ts";
import {
  SessionCredentialService,
  type SessionCredentialChange,
} from "./auth/Services/SessionCredentialService.ts";
import { respondToAuthError } from "./auth/http.ts";
import {
  cadHierarchyRequestStream,
  cadViewCommandStream,
  completeCadHierarchyRequest,
  publishCadViewCommand,
} from "./cad/CadViewCommands.ts";
import {
  cadScreenshotRequestStream,
  completeCadScreenshotPending,
  getCadScreenshotPendingExportRoot,
  getCadScreenshotPendingSuggestedBaseName,
  getCadScreenshotPendingThreadId,
  makeCadScreenshotFilename,
  MAX_SCREENSHOT_BYTES,
  rejectCadScreenshotPending,
} from "./cad/CadScreenshotCapture.ts";
import { buildCadModelUrl } from "./cad/cadModelHttpPath.ts";
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
const isWorkspacePathOutsideRootError = Schema.is(WorkspacePathOutsideRootError);
const isOnshapeRpcError = Schema.is(OnshapeRpcError);
const isMechbaseRpcError = Schema.is(MechbaseRpcError);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function normalizeCadRelativePath(relativePath: string): string | null {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    !isOnshapeSyncRelativePath(normalized) ||
    !isSupportedCadModelPath(normalized)
  ) {
    return null;
  }
  return normalized;
}

function isWithinRoot(pathService: Path.Path, root: string, candidate: string): boolean {
  const normalizedRoot = pathService.resolve(root);
  const normalizedCandidate = pathService.resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(
      normalizedRoot.endsWith(pathService.sep)
        ? normalizedRoot
        : `${normalizedRoot}${pathService.sep}`,
    )
  );
}

const BUNDLE_SYNC_RELATIVE_PREFIX = `${CAD_SYNC_DIRECTORY}/bundle`;

function toCadFileSizeBytes(size: bigint | number): number {
  const asBigInt = typeof size === "bigint" ? size : BigInt(Math.max(0, Math.trunc(size)));
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(asBigInt > maxSafe ? maxSafe : asBigInt);
}

function cadFileCacheVersion(stat: {
  readonly size: bigint | number;
  readonly mtime: Option.Option<Date>;
}) {
  return Option.isSome(stat.mtime)
    ? `${stat.size.toString()}-${stat.mtime.value.getTime()}`
    : stat.size.toString();
}

function isBundleObjPreviewPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const ext = getCadModelExtension(normalized);
  return (
    ext === "obj" &&
    (normalized === BUNDLE_SYNC_RELATIVE_PREFIX ||
      normalized.startsWith(`${BUNDLE_SYNC_RELATIVE_PREFIX}/`))
  );
}

const pickLargestObjInBundleEffect = (input: {
  readonly workspaceRoot: string;
  readonly syncRoot: string;
  readonly pathService: Path.Path;
  readonly fileSystem: FileSystem.FileSystem;
}): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const bundleAbs = input.pathService.resolve(
      input.workspaceRoot,
      input.pathService.join(CAD_SYNC_DIRECTORY, "bundle"),
    );
    const entries = yield* input.fileSystem
      .readDirectory(bundleAbs, { recursive: true })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])));
    let best: string | null = null;
    let bestSize = 0n;
    for (const entry of entries) {
      const entrySlash = entry.replaceAll("\\", "/");
      const rel = normalizeCadRelativePath(`${CAD_SYNC_DIRECTORY}/bundle/${entrySlash}`);
      if (rel === null || getCadModelExtension(rel) !== "obj") {
        continue;
      }
      const abs = input.pathService.resolve(input.workspaceRoot, rel);
      if (!isWithinRoot(input.pathService, input.syncRoot, abs)) {
        continue;
      }
      const stat = yield* input.fileSystem.stat(abs).pipe(Effect.catch(() => Effect.succeed(null)));
      if (!stat || stat.type !== "File") {
        continue;
      }
      if (stat.size > bestSize) {
        bestSize = stat.size;
        best = rel;
      }
    }
    return best;
  });

const listObjAndMaterialLibs = (input: {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly syncRoot: string;
  readonly pathService: Path.Path;
  readonly fileSystem: FileSystem.FileSystem;
  readonly objRelativePath: string;
}): Effect.Effect<OnshapeSyncedCadFile[], never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const absoluteObj = input.pathService.resolve(input.workspaceRoot, input.objRelativePath);
    const objStat = yield* input.fileSystem
      .stat(absoluteObj)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const files: OnshapeSyncedCadFile[] = [
      {
        relativePath: input.objRelativePath,
        url:
          objStat?.type === "File"
            ? buildCadModelUrl(input.cwd, input.objRelativePath, cadFileCacheVersion(objStat))
            : buildCadModelUrl(input.cwd, input.objRelativePath),
        isPreferred: true,
        ...(objStat?.type === "File" ? { sizeBytes: toCadFileSizeBytes(objStat.size) } : {}),
      },
    ];
    const objText = yield* input.fileSystem
      .readFileString(absoluteObj)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const seen = new Set(files.map((f) => f.relativePath));
    if (objText !== null) {
      const head =
        objText.length > OBJ_MTLLIB_SCAN_MAX_BYTES
          ? objText.slice(0, OBJ_MTLLIB_SCAN_MAX_BYTES)
          : objText;
      const mtllibs = parseObjMtllibFilenames(head);
      const objDir = input.pathService.dirname(input.objRelativePath);
      for (const mtlName of mtllibs) {
        if (mtlName.includes("\0")) {
          continue;
        }
        const mtlRelJoinedSlash = input.pathService.join(objDir, mtlName).replaceAll("\\", "/");
        const mtlRelative = normalizeCadRelativePath(mtlRelJoinedSlash);
        if (mtlRelative === null || seen.has(mtlRelative)) {
          continue;
        }
        const mtlAbsolute = input.pathService.resolve(input.workspaceRoot, mtlRelative);
        if (!isWithinRoot(input.pathService, input.syncRoot, mtlAbsolute)) {
          continue;
        }
        const mtlStat = yield* input.fileSystem
          .stat(mtlAbsolute)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (mtlStat?.type !== "File") {
          continue;
        }
        seen.add(mtlRelative);
        files.push({
          relativePath: mtlRelative,
          url: buildCadModelUrl(input.cwd, mtlRelative, cadFileCacheVersion(mtlStat)),
          isPreferred: true,
          sizeBytes: toCadFileSizeBytes(mtlStat.size),
        });
      }
    }

    const mtlRelativePaths = files
      .map((f) => f.relativePath)
      .filter((rel) => getCadModelExtension(rel) === "mtl");
    for (const mtlRelativePath of mtlRelativePaths) {
      const mtlAbsolutePath = input.pathService.resolve(input.workspaceRoot, mtlRelativePath);
      const mtlText = yield* input.fileSystem
        .readFileString(mtlAbsolutePath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (mtlText === null) {
        continue;
      }
      const mtlDir = input.pathService.dirname(mtlRelativePath);
      for (const assetName of parseMtlReferencedAssetFilenames(mtlText)) {
        if (assetName.includes("\0")) {
          continue;
        }
        const assetRelJoined = input.pathService.join(mtlDir, assetName).replaceAll("\\", "/");
        const assetRelative = normalizeCadRelativePath(assetRelJoined);
        if (assetRelative === null || seen.has(assetRelative)) {
          continue;
        }
        const assetAbsolute = input.pathService.resolve(input.workspaceRoot, assetRelative);
        if (!isWithinRoot(input.pathService, input.syncRoot, assetAbsolute)) {
          continue;
        }
        const assetStat = yield* input.fileSystem
          .stat(assetAbsolute)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (assetStat?.type !== "File") {
          continue;
        }
        seen.add(assetRelative);
        files.push({
          relativePath: assetRelative,
          url: buildCadModelUrl(input.cwd, assetRelative, cadFileCacheVersion(assetStat)),
          isPreferred: true,
          sizeBytes: toCadFileSizeBytes(assetStat.size),
        });
      }
    }

    const objDirRel = input.pathService.dirname(input.objRelativePath);
    const objDirAbs = input.pathService.resolve(input.workspaceRoot, objDirRel);
    const dirEntries = yield* input.fileSystem
      .readDirectory(objDirAbs)
      .pipe(Effect.catch(() => Effect.succeed([] as string[])));
    for (const name of dirEntries) {
      const childRelJoined = input.pathService.join(objDirRel, name).replaceAll("\\", "/");
      const childRelative = normalizeCadRelativePath(childRelJoined);
      if (
        childRelative === null ||
        !isObjPreviewCompanionPath(childRelative) ||
        seen.has(childRelative)
      ) {
        continue;
      }
      const childAbs = input.pathService.resolve(input.workspaceRoot, childRelative);
      if (!isWithinRoot(input.pathService, input.syncRoot, childAbs)) {
        continue;
      }
      const childStat = yield* input.fileSystem
        .stat(childAbs)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (childStat?.type !== "File") {
        continue;
      }
      seen.add(childRelative);
      files.push({
        relativePath: childRelative,
        url: buildCadModelUrl(input.cwd, childRelative, cadFileCacheVersion(childStat)),
        isPreferred: true,
        sizeBytes: toCadFileSizeBytes(childStat.size),
      });
    }

    return files;
  });

const listSyncedCadFiles = (input: {
  readonly cwd: string;
  readonly preferredRelativePath?: string;
}): Effect.Effect<OnshapeListSyncedCadFilesResult, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const workspaceRoot = pathService.resolve(input.cwd);
    const syncRoot = pathService.resolve(workspaceRoot, CAD_SYNC_DIRECTORY);
    const preferred = input.preferredRelativePath
      ? normalizeCadRelativePath(input.preferredRelativePath)
      : null;

    // When the thread/project pins a sync output, load that artifact (+ companion MTL for OBJ).
    // Listing the whole sync tree used to pass every historical file into Online3DViewer and
    // triggered redundant imports.
    if (preferred !== null) {
      let viewerObjPath = preferred;
      if (isBundleObjPreviewPath(preferred)) {
        const largestInBundle = yield* pickLargestObjInBundleEffect({
          workspaceRoot,
          syncRoot,
          pathService,
          fileSystem,
        });
        if (largestInBundle !== null) {
          viewerObjPath = largestInBundle;
        }
      }
      const absolutePath = pathService.resolve(workspaceRoot, viewerObjPath);
      if (isWithinRoot(pathService, syncRoot, absolutePath)) {
        const stat = yield* fileSystem
          .stat(absolutePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (stat?.type === "File" && getCadModelExtension(viewerObjPath) === "obj") {
          const files = yield* listObjAndMaterialLibs({
            cwd: input.cwd,
            workspaceRoot,
            syncRoot,
            pathService,
            fileSystem,
            objRelativePath: viewerObjPath,
          });
          return { files };
        }
        if (stat?.type === "File") {
          return {
            files: [
              {
                relativePath: viewerObjPath,
                url: buildCadModelUrl(input.cwd, viewerObjPath, cadFileCacheVersion(stat)),
                isPreferred: true,
                sizeBytes: toCadFileSizeBytes(stat.size),
              },
            ],
          };
        }
      }
    }

    const candidates = new Set<string>();
    candidates.add(preferred ?? DEFAULT_ONSHAPE_SYNC_MODEL_PATH);

    const entries = yield* fileSystem
      .readDirectory(syncRoot, { recursive: true })
      .pipe(Effect.catch(() => Effect.succeed([])));
    for (const entry of entries) {
      const normalized = normalizeCadRelativePath(`${CAD_SYNC_DIRECTORY}/${entry}`);
      if (normalized) {
        candidates.add(normalized);
      }
    }

    const collected: {
      readonly relativePath: string;
      readonly url: string;
      readonly size: bigint;
    }[] = [];
    for (const relativePath of candidates) {
      const absolutePath = pathService.resolve(workspaceRoot, relativePath);
      if (!isWithinRoot(pathService, syncRoot, absolutePath)) {
        continue;
      }
      const stat = yield* fileSystem
        .stat(absolutePath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!stat || stat.type !== "File") {
        continue;
      }
      collected.push({
        relativePath,
        url: buildCadModelUrl(input.cwd, relativePath, cadFileCacheVersion(stat)),
        size: stat.size,
      });
    }

    const preferredRow =
      preferred !== null ? collected.find((c) => c.relativePath === preferred) : undefined;
    if (preferredRow && getCadModelExtension(preferredRow.relativePath) !== "obj") {
      return {
        files: [
          {
            relativePath: preferredRow.relativePath,
            url: preferredRow.url,
            isPreferred: true,
            sizeBytes: toCadFileSizeBytes(preferredRow.size),
          },
        ],
      };
    }

    const defaultRow = collected.find((c) => c.relativePath === DEFAULT_ONSHAPE_SYNC_MODEL_PATH);
    if (
      preferred === null &&
      defaultRow &&
      getCadModelExtension(defaultRow.relativePath) !== "obj"
    ) {
      return {
        files: [
          {
            relativePath: defaultRow.relativePath,
            url: defaultRow.url,
            isPreferred: true,
            sizeBytes: toCadFileSizeBytes(defaultRow.size),
          },
        ],
      };
    }

    const objRows = collected.filter((c) => getCadModelExtension(c.relativePath) === "obj");
    if (objRows.length > 1) {
      const primary = objRows.reduce((a, b) => (a.size >= b.size ? a : b));
      const files = yield* listObjAndMaterialLibs({
        cwd: input.cwd,
        workspaceRoot,
        syncRoot,
        pathService,
        fileSystem,
        objRelativePath: primary.relativePath,
      });
      return { files };
    }

    return {
      files: collected.map((c) => ({
        relativePath: c.relativePath,
        url: c.url,
        isPreferred: preferred !== null && c.relativePath === preferred,
        sizeBytes: toCadFileSizeBytes(c.size),
      })),
    };
  });

function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.review-requested"
      | "thread.review-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.turn-start-requested"
      | "thread.reverted"
      | "thread.session-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.review-requested" ||
    event.type === "thread.review-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.turn-start-requested" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;
const ACTIVE_CAD_REVIEW_STATUSES = new Set<CadReviewStatus>([
  "requested",
  "planning",
  "capturing-baseline",
  "reviewing",
  "deep-diving",
  "synthesizing",
]);

function isActiveCadReviewStatus(status: CadReviewStatus): boolean {
  return ACTIVE_CAD_REVIEW_STATUSES.has(status);
}

const OnshapeWorkspaceRouteLayer = OnshapeWorkspaceLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      OnshapeIndexRepositoryLive.pipe(Layer.provide(SqlitePersistenceLayerLive)),
      ServerSecretStoreLive,
    ),
  ),
);

function toAuthAccessStreamEvent(
  change: BootstrapCredentialChange | SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const makeWsRpcLayer = (currentSessionId: AuthSessionId) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const checkpointDiffQuery = yield* CheckpointDiffQuery;
      const keybindings = yield* Keybindings;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const gitWorkflow = yield* GitWorkflowService;
      const vcsProvisioning = yield* VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
      const providerRegistry = yield* ProviderRegistry;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const config = yield* ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents;
      const serverSettings = yield* ServerSettingsService;
      const startup = yield* ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem;
      const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
      const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
      const serverEnvironment = yield* ServerEnvironment;
      const serverAuth = yield* ServerAuth;
      const sourceControlDiscovery = yield* SourceControlDiscoveryLayer.SourceControlDiscovery;
      const automaticGitFetchInterval = serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.automaticGitFetchInterval),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read automatic Git fetch interval setting", {
            detail: cause.message,
          }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
        ),
      );
      const sourceControlRepositories = yield* SourceControlRepositoryService;
      const bootstrapCredentials = yield* BootstrapCredentialService;
      const sessions = yield* SessionCredentialService;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
      const serverCommandId = (tag: string) =>
        CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks().pipe(Effect.orDie),
          clientSessions: serverAuth.listClientSessions(currentSessionId).pipe(Effect.orDie),
        });

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: serverCommandId("setup-script-activity"),
          threadId: input.threadId,
          activity: {
            id: EventId.make(crypto.randomUUID()),
            tone: input.tone,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        });

      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
        isOrchestrationDispatchCommandError(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: cause instanceof Error ? cause.message : fallbackMessage,
              cause,
            });

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause);
        return isOrchestrationDispatchCommandError(error)
          ? error
          : new OrchestrationDispatchCommandError({
              message:
                error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
              cause,
            });
      };

      const enrichProjectEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<OrchestrationEvent, never, never> => {
        switch (event.type) {
          case "project.created":
            return repositoryIdentityResolver.resolve(event.payload.workspaceRoot).pipe(
              Effect.map((repositoryIdentity) => ({
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              })),
            );
          case "project.meta-updated":
            return Effect.gen(function* () {
              const workspaceRoot =
                event.payload.workspaceRoot ??
                Option.match(
                  yield* projectionSnapshotQuery.getProjectShellById(event.payload.projectId),
                  {
                    onNone: () => null,
                    onSome: (project) => project.workspaceRoot,
                  },
                ) ??
                null;
              if (workspaceRoot === null) {
                return event;
              }

              const repositoryIdentity = yield* repositoryIdentityResolver.resolve(workspaceRoot);
              return {
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              } satisfies OrchestrationEvent;
            }).pipe(Effect.catch(() => Effect.succeed(event)));
          default:
            return Effect.succeed(event);
        }
      };

      const enrichOrchestrationEvents = (events: ReadonlyArray<OrchestrationEvent>) =>
        Effect.forEach(events, enrichProjectEvent, { concurrency: 4 });

      const toShellStreamEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
            return projectionSnapshotQuery.getProjectShellById(event.payload.projectId).pipe(
              Effect.map((project) =>
                Option.map(project, (nextProject) => ({
                  kind: "project-upserted" as const,
                  sequence: event.sequence,
                  project: nextProject,
                })),
              ),
              Effect.catch(() => Effect.succeed(Option.none())),
            );
          case "project.deleted":
            return Effect.succeed(
              Option.some({
                kind: "project-removed" as const,
                sequence: event.sequence,
                projectId: event.payload.projectId,
              }),
            );
          case "thread.deleted":
          case "thread.archived":
            return Effect.succeed(
              Option.some({
                kind: "thread-removed" as const,
                sequence: event.sequence,
                threadId: event.payload.threadId,
              }),
            );
          case "thread.unarchived":
            return projectionSnapshotQuery.getThreadShellById(event.payload.threadId).pipe(
              Effect.map((thread) =>
                Option.map(thread, (nextThread) => ({
                  kind: "thread-upserted" as const,
                  sequence: event.sequence,
                  thread: nextThread,
                })),
              ),
              Effect.catch(() => Effect.succeed(Option.none())),
            );
          case "thread.review-stop-requested":
            return Effect.succeed(Option.none());
          case "thread.review-upserted":
            return projectionSnapshotQuery.getThreadDetailById(event.payload.threadId).pipe(
              Effect.flatMap((threadDetail) =>
                projectionSnapshotQuery.getThreadShellById(event.payload.threadId).pipe(
                  Effect.map((thread) => {
                    if (Option.isNone(thread)) {
                      return Option.none<OrchestrationShellStreamEvent>();
                    }

                    const reviews = Option.isSome(threadDetail)
                      ? (threadDetail.value.reviews ?? [])
                      : [];
                    const mergedReviews = [
                      ...reviews.filter((review) => review.id !== event.payload.review.id),
                      event.payload.review,
                    ];
                    return Option.some({
                      kind: "thread-upserted" as const,
                      sequence: event.sequence,
                      thread: {
                        ...thread.value,
                        hasActiveReview: mergedReviews.some((review) =>
                          isActiveCadReviewStatus(review.status),
                        ),
                      },
                    });
                  }),
                ),
              ),
              Effect.catch(() => Effect.succeed(Option.none())),
            );
          default:
            if (event.aggregateKind !== "thread") {
              return Effect.succeed(Option.none());
            }
            return projectionSnapshotQuery
              .getThreadShellById(ThreadId.make(event.aggregateId))
              .pipe(
                Effect.map((thread) =>
                  Option.map(thread, (nextThread) => ({
                    kind: "thread-upserted" as const,
                    sequence: event.sequence,
                    thread: nextThread,
                  })),
                ),
                Effect.catch(() => Effect.succeed(Option.none())),
              );
        }
      };

      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const bootstrap = command.bootstrap;
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
          let createdThread = false;
          let targetProjectId = bootstrap?.createThread?.projectId;
          let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

          const cleanupCreatedThread = () =>
            createdThread
              ? orchestrationEngine
                  .dispatch({
                    type: "thread.delete",
                    commandId: serverCommandId("bootstrap-thread-delete"),
                    threadId: command.threadId,
                  })
                  .pipe(Effect.ignoreCause({ log: true }))
              : Effect.void;

          const recordSetupScriptLaunchFailure = (input: {
            readonly error: unknown;
            readonly requestedAt: string;
            readonly worktreePath: string;
          }) => {
            const detail =
              input.error instanceof Error ? input.error.message : "Unknown setup failure.";
            return appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.failed",
              summary: "Setup script failed to start",
              createdAt: input.requestedAt,
              payload: {
                detail,
                worktreePath: input.worktreePath,
              },
              tone: "error",
            }).pipe(
              Effect.ignoreCause({ log: false }),
              Effect.flatMap(() =>
                Effect.logWarning("bootstrap turn start failed to launch setup script", {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  detail,
                }),
              ),
            );
          };

          const recordSetupScriptStarted = (input: {
            readonly requestedAt: string;
            readonly worktreePath: string;
            readonly scriptId: string;
            readonly scriptName: string;
            readonly terminalId: string;
          }) =>
            Effect.gen(function* () {
              const startedAt = yield* nowIso;
              const payload = {
                scriptId: input.scriptId,
                scriptName: input.scriptName,
                terminalId: input.terminalId,
                worktreePath: input.worktreePath,
              };
              yield* Effect.all([
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.requested",
                  summary: "Starting setup script",
                  createdAt: input.requestedAt,
                  payload,
                  tone: "info",
                }),
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.started",
                  summary: "Setup script started",
                  createdAt: startedAt,
                  payload,
                  tone: "info",
                }),
              ]).pipe(
                Effect.asVoid,
                Effect.catch((error) =>
                  Effect.logWarning(
                    "bootstrap turn start launched setup script but failed to record setup activity",
                    {
                      threadId: command.threadId,
                      worktreePath: input.worktreePath,
                      scriptId: input.scriptId,
                      terminalId: input.terminalId,
                      detail: error.message,
                    },
                  ),
                ),
              );
            });

          const runSetupProgram = () =>
            Effect.gen(function* () {
              if (!bootstrap?.runSetupScript || !targetWorktreePath) {
                return;
              }
              const worktreePath = targetWorktreePath;
              const requestedAt = yield* nowIso;
              yield* projectSetupScriptRunner
                .runForThread({
                  threadId: command.threadId,
                  ...(targetProjectId ? { projectId: targetProjectId } : {}),
                  ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                  worktreePath,
                })
                .pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      recordSetupScriptLaunchFailure({
                        error,
                        requestedAt,
                        worktreePath,
                      }),
                    onSuccess: (setupResult) => {
                      if (setupResult.status !== "started") {
                        return Effect.void;
                      }
                      return recordSetupScriptStarted({
                        requestedAt,
                        worktreePath,
                        scriptId: setupResult.scriptId,
                        scriptName: setupResult.scriptName,
                        terminalId: setupResult.terminalId,
                      });
                    },
                  }),
                );
            });

          const bootstrapProgram = Effect.gen(function* () {
            if (bootstrap?.createThread) {
              yield* orchestrationEngine.dispatch({
                type: "thread.create",
                commandId: serverCommandId("bootstrap-thread-create"),
                threadId: command.threadId,
                projectId: bootstrap.createThread.projectId,
                title: bootstrap.createThread.title,
                modelSelection: bootstrap.createThread.modelSelection,
                runtimeMode: bootstrap.createThread.runtimeMode,
                interactionMode: bootstrap.createThread.interactionMode,
                branch: bootstrap.createThread.branch,
                worktreePath: bootstrap.createThread.worktreePath,
                createdAt: bootstrap.createThread.createdAt,
              });
              createdThread = true;
            }

            if (bootstrap?.prepareWorktree) {
              const worktree = yield* gitWorkflow.createWorktree({
                cwd: bootstrap.prepareWorktree.projectCwd,
                refName: bootstrap.prepareWorktree.baseBranch,
                newRefName: bootstrap.prepareWorktree.branch,
                path: null,
              });
              targetWorktreePath = worktree.worktree.path;
              yield* orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: serverCommandId("bootstrap-thread-meta-update"),
                threadId: command.threadId,
                branch: worktree.worktree.refName,
                worktreePath: targetWorktreePath,
              });
              yield* refreshGitStatus(targetWorktreePath);
            }

            yield* runSetupProgram();

            return yield* orchestrationEngine.dispatch(finalTurnStartCommand);
          });

          return yield* bootstrapProgram.pipe(
            Effect.catchCause((cause) => {
              const dispatchError = toBootstrapDispatchCommandCauseError(cause);
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.fail(dispatchError);
              }
              return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.fail(dispatchError)));
            }),
          );
        });

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
        const dispatchEffect =
          normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
            ? dispatchBootstrapTurnStart(normalizedCommand)
            : orchestrationEngine
                .dispatch(normalizedCommand)
                .pipe(
                  Effect.mapError((cause) =>
                    toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                  ),
                );

        return startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      };

      const loadServerConfig = Effect.gen(function* () {
        const keybindingsConfig = yield* keybindings.loadConfigState;
        const providers = yield* providerRegistry.getProviders;
        const settings = redactServerSettingsForClient(yield* serverSettings.getSettings);
        const environment = yield* serverEnvironment.getDescriptor;
        const auth = yield* serverAuth.getDescriptor();

        return {
          environment,
          auth,
          cwd: config.cwd,
          keybindingsConfigPath: config.keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors: ExternalLauncher.resolveAvailableEditors(),
          observability: {
            logsDirectoryPath: config.logsDir,
            localTracingEnabled: true,
            ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
            otlpTracesEnabled: config.otlpTracesUrl !== undefined,
            ...(config.otlpMetricsUrl !== undefined
              ? { otlpMetricsUrl: config.otlpMetricsUrl }
              : {}),
            otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
          },
          settings,
        };
      });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      return WsRpcGroup.of({
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              const normalizedCommand = yield* normalizeDispatchCommand(command);
              const shouldStopSessionAfterArchive =
                normalizedCommand.type === "thread.archive"
                  ? yield* projectionSnapshotQuery
                      .getThreadShellById(normalizedCommand.threadId)
                      .pipe(
                        Effect.map(
                          Option.match({
                            onNone: () => false,
                            onSome: (thread) =>
                              thread.session !== null && thread.session.status !== "stopped",
                          }),
                        ),
                        Effect.catch(() => Effect.succeed(false)),
                      )
                  : false;
              const result = yield* dispatchNormalizedCommand(normalizedCommand);
              if (normalizedCommand.type === "thread.archive") {
                if (shouldStopSessionAfterArchive) {
                  yield* Effect.gen(function* () {
                    const stopCommand = yield* normalizeDispatchCommand({
                      type: "thread.session.stop",
                      commandId: CommandId.make(
                        `session-stop-for-archive:${normalizedCommand.commandId}`,
                      ),
                      threadId: normalizedCommand.threadId,
                      createdAt: yield* nowIso,
                    });

                    yield* dispatchNormalizedCommand(stopCommand);
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("failed to stop provider session during archive", {
                        threadId: normalizedCommand.threadId,
                        cause,
                      }),
                    ),
                  );
                }
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationDispatchCommandError(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            checkpointDiffQuery.getTurnDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffError({
                    message: "Failed to load turn diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            checkpointDiffQuery.getFullThreadDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffError({
                    message: "Failed to load full thread diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.replayEvents]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.replayEvents,
            Stream.runCollect(
              orchestrationEngine.readEvents(
                clamp(input.fromSequenceExclusive, {
                  maximum: Number.MAX_SAFE_INTEGER,
                  minimum: 0,
                }),
              ),
            ).pipe(
              Effect.map((events) => Array.from(events)),
              Effect.flatMap(enrichOrchestrationEvents),
              Effect.mapError(
                (cause) =>
                  new OrchestrationReplayEventsError({
                    message: "Failed to replay orchestration events",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (_input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
                Effect.tapError((cause) =>
                  Effect.logError("orchestration shell snapshot load failed", { cause }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to load orchestration shell snapshot",
                      cause,
                    }),
                ),
              );

              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.mapEffect(toShellStreamEvent),
                Stream.flatMap((event) =>
                  Option.isSome(event) ? Stream.succeed(event.value) : Stream.empty,
                ),
              );

              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot,
                }),
                liveStream,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
            projectionSnapshotQuery.getArchivedShellSnapshot().pipe(
              Effect.tapError((cause) =>
                Effect.logError("orchestration archived shell snapshot load failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load archived orchestration shell snapshot",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.gen(function* () {
              const [threadDetail, snapshotSequence] = yield* Effect.all([
                projectionSnapshotQuery.getThreadDetailById(input.threadId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to load thread ${input.threadId}`,
                        cause,
                      }),
                  ),
                ),
                projectionSnapshotQuery.getSnapshotSequence().pipe(
                  Effect.map(({ snapshotSequence }) => snapshotSequence),
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to load orchestration snapshot sequence",
                        cause,
                      }),
                  ),
                ),
              ]);

              if (Option.isNone(threadDetail)) {
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} was not found`,
                  cause: input.threadId,
                });
              }

              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.filter(
                  (event) =>
                    event.aggregateKind === "thread" &&
                    event.aggregateId === input.threadId &&
                    isThreadDetailEvent(event),
                ),
                Stream.map((event) => ({
                  kind: "event" as const,
                  event,
                })),
              );

              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot: {
                    snapshotSequence,
                    thread: threadDetail.value,
                  },
                }),
                liveStream,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            (input.instanceId !== undefined
              ? providerRegistry.refreshInstance(input.instanceId)
              : providerRegistry.refresh()
            ).pipe(Effect.map((providers) => ({ providers }))),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProvider,
            providerMaintenanceRunner.updateProvider(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(Effect.map(redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            serverSettings.updateSettings(patch).pipe(Effect.map(redactServerSettingsForClient)),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            sourceControlDiscovery.discover,
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetTraceDiagnostics,
            TraceDiagnostics.readTraceDiagnostics({
              traceFilePath: config.serverTracePath,
              maxFiles: config.traceMaxFiles,
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetProcessDiagnostics, processDiagnostics.read, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessResourceHistory,
            processResourceMonitor.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverSignalProcess]: (input) =>
          observeRpcEffect(WS_METHODS.serverSignalProcess, processDiagnostics.signal(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            sourceControlRepositories.lookupRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            sourceControlRepositories.cloneRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            sourceControlRepositories
              .publishRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.onshapeListConnections]: (_input) =>
          observeRpcEffect(
            WS_METHODS.onshapeListConnections,
            Effect.gen(function* () {
              const onshapeWorkspace = yield* OnshapeWorkspace;
              return yield* onshapeWorkspace.listConnections();
            }).pipe(
              Effect.provide(OnshapeWorkspaceRouteLayer),
              Effect.mapError(
                (cause) =>
                  new OnshapeRpcError({
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "Failed to list Onshape connections.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "onshape" },
          ),
        [WS_METHODS.onshapeSetupConnection]: (input) =>
          observeRpcEffect(
            WS_METHODS.onshapeSetupConnection,
            Effect.gen(function* () {
              const onshapeWorkspace = yield* OnshapeWorkspace;
              return yield* onshapeWorkspace.setupConnection(input);
            }).pipe(
              Effect.provide(OnshapeWorkspaceRouteLayer),
              Effect.mapError(
                (cause) =>
                  new OnshapeRpcError({
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "Failed to set up Onshape connection.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "onshape" },
          ),
        [WS_METHODS.mechbaseListConnections]: (_input) =>
          observeRpcEffect(
            WS_METHODS.mechbaseListConnections,
            Effect.gen(function* () {
              const secretStore = yield* ServerSecretStore;
              const storedApiKey = yield* secretStore.get(MECHBASE_API_KEY_SECRET_NAME);
              if (storedApiKey === null) {
                return { connections: [] };
              }
              yield* Effect.tryPromise(() =>
                validateMechbaseApiKey(decodeMechbaseApiKey(storedApiKey)),
              );
              return {
                connections: [
                  {
                    displayName: "Mechbase" as const,
                    apiKeyConfigured: true,
                  },
                ],
              };
            }).pipe(
              Effect.provide(ServerSecretStoreLive),
              Effect.mapError(
                (cause) =>
                  new MechbaseRpcError({
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "Failed to list Mechbase connections.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "mechbase" },
          ),
        [WS_METHODS.mechbaseSetupConnection]: (input) =>
          observeRpcEffect(
            WS_METHODS.mechbaseSetupConnection,
            Effect.gen(function* () {
              const apiKey = input.apiKey.trim();
              if (apiKey.length === 0) {
                return yield* new MechbaseRpcError({ message: "Mechbase API key is required." });
              }
              yield* Effect.tryPromise(() => validateMechbaseApiKey(apiKey));
              const secretStore = yield* ServerSecretStore;
              yield* secretStore.set(MECHBASE_API_KEY_SECRET_NAME, encodeMechbaseApiKey(apiKey));
              return {
                connection: {
                  displayName: "Mechbase" as const,
                  apiKeyConfigured: true,
                },
              };
            }).pipe(
              Effect.provide(ServerSecretStoreLive),
              Effect.mapError((cause) =>
                isMechbaseRpcError(cause)
                  ? cause
                  : new MechbaseRpcError({
                      message:
                        cause instanceof Error
                          ? cause.message
                          : "Failed to set up Mechbase connection.",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "mechbase" },
          ),
        [WS_METHODS.onshapeImportUrl]: (input) =>
          observeRpcEffect(
            WS_METHODS.onshapeImportUrl,
            Effect.gen(function* () {
              const onshapeWorkspace = yield* OnshapeWorkspace;
              return yield* onshapeWorkspace.importUrl(input);
            }).pipe(
              Effect.provide(OnshapeWorkspaceRouteLayer),
              Effect.mapError(
                (cause) =>
                  new OnshapeRpcError({
                    message:
                      cause instanceof Error ? cause.message : "Failed to import Onshape URL.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "onshape" },
          ),
        [WS_METHODS.onshapeRefreshIndex]: (input) =>
          observeRpcEffect(
            WS_METHODS.onshapeRefreshIndex,
            Effect.gen(function* () {
              const onshapeWorkspace = yield* OnshapeWorkspace;
              return yield* onshapeWorkspace.refreshIndex(input);
            }).pipe(
              Effect.provide(OnshapeWorkspaceRouteLayer),
              Effect.mapError(
                (cause) =>
                  new OnshapeRpcError({
                    message:
                      cause instanceof Error ? cause.message : "Failed to refresh Onshape index.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "onshape" },
          ),
        [WS_METHODS.onshapeSearchIndex]: (input) =>
          observeRpcEffect(
            WS_METHODS.onshapeSearchIndex,
            Effect.gen(function* () {
              const onshapeWorkspace = yield* OnshapeWorkspace;
              return yield* onshapeWorkspace.searchIndex(input);
            }).pipe(
              Effect.provide(OnshapeWorkspaceRouteLayer),
              Effect.mapError(
                (cause) =>
                  new OnshapeRpcError({
                    message:
                      cause instanceof Error ? cause.message : "Failed to search Onshape index.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "onshape" },
          ),
        [WS_METHODS.onshapeSyncProject]: (input) =>
          observeRpcEffect(
            WS_METHODS.onshapeSyncProject,
            Effect.gen(function* () {
              const onshapeWorkspace = yield* OnshapeWorkspace;
              return yield* onshapeWorkspace.syncProject(input);
            }).pipe(
              Effect.provide(OnshapeWorkspaceRouteLayer),
              Effect.mapError(
                (cause) =>
                  new OnshapeRpcError({
                    message:
                      cause instanceof Error ? cause.message : "Failed to sync Onshape project.",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "onshape" },
          ),
        [WS_METHODS.onshapeListSyncedCadFiles]: (input) =>
          observeRpcEffect(WS_METHODS.onshapeListSyncedCadFiles, listSyncedCadFiles(input), {
            "rpc.aggregate": "onshape",
          }),
        [WS_METHODS.cadSetView]: (input) =>
          observeRpcEffect(WS_METHODS.cadSetView, publishCadViewCommand(input), {
            "rpc.aggregate": "cad",
          }),
        [WS_METHODS.cadHierarchyUpload]: (input) =>
          observeRpcEffect(
            WS_METHODS.cadHierarchyUpload,
            Effect.gen(function* () {
              const result = { components: input.components };
              if (!completeCadHierarchyRequest(input.requestId, result)) {
                return yield* new OnshapeRpcError({
                  message: "Unknown or expired CAD hierarchy request.",
                });
              }
              return result;
            }),
            { "rpc.aggregate": "cad" },
          ),
        [WS_METHODS.cadScreenshotUpload]: (input) =>
          observeRpcEffect(
            WS_METHODS.cadScreenshotUpload,
            Effect.gen(function* () {
              const exportRoot = getCadScreenshotPendingExportRoot(input.requestId);
              const threadId = getCadScreenshotPendingThreadId(input.requestId);
              if (!exportRoot || !threadId) {
                return yield* new OnshapeRpcError({
                  message: "Unknown or expired CAD screenshot request.",
                });
              }
              const decoded = yield* Effect.sync(() => Buffer.from(input.pngBase64, "base64"));
              if (decoded.byteLength === 0) {
                rejectCadScreenshotPending(input.requestId, "Screenshot payload was empty.");
                return yield* new OnshapeRpcError({ message: "Screenshot payload was empty." });
              }
              if (decoded.byteLength > MAX_SCREENSHOT_BYTES) {
                rejectCadScreenshotPending(input.requestId, "Screenshot too large.");
                return yield* new OnshapeRpcError({
                  message: "Screenshot exceeds maximum size.",
                });
              }
              const pathService = yield* Path.Path;
              const fileSystem = yield* FileSystem.FileSystem;
              const directory = pathService.join(exportRoot, threadId);
              yield* fileSystem.makeDirectory(directory, { recursive: true });
              const now = yield* DateTime.now;
              const stamp = DateTime.formatIso(now).replace(/[:.]/g, "-");
              const filename = makeCadScreenshotFilename(
                stamp,
                getCadScreenshotPendingSuggestedBaseName(input.requestId),
              );
              const absolutePath = pathService.join(directory, filename);
              yield* fileSystem.writeFile(absolutePath, new Uint8Array(decoded));
              const relativePath = `${threadId}/${filename}`.replaceAll("\\", "/");
              const completed = completeCadScreenshotPending(input.requestId, {
                requestId: input.requestId,
                absolutePath,
                relativePath,
              });
              if (!completed) {
                yield* fileSystem.remove(absolutePath).pipe(Effect.ignore);
                return yield* new OnshapeRpcError({
                  message: "CAD screenshot request was already finalized.",
                });
              }
              return { absolutePath, relativePath };
            }).pipe(
              Effect.mapError(
                (e): OnshapeRpcError =>
                  isOnshapeRpcError(e)
                    ? e
                    : new OnshapeRpcError({
                        message: e instanceof Error ? e.message : "Failed to save CAD screenshot.",
                        cause: e instanceof Error ? e : undefined,
                      }),
              ),
            ),
            { "rpc.aggregate": "cad" },
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            workspaceEntries.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchEntriesError({
                    message: `Failed to search workspace entries: ${cause.detail}`,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            workspaceFileSystem.writeFile(input).pipe(
              Effect.mapError((cause) => {
                const message = isWorkspacePathOutsideRootError(cause)
                  ? "Workspace file path must stay within the project root."
                  : "Failed to write workspace file";
                return new ProjectWriteFileError({
                  message,
                  cause,
                });
              }),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, externalLauncher.launchEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            workspaceEntries.browse(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemBrowseError({
                    message: cause.detail,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeVcsStatus,
            vcsStatusBroadcaster.streamStatus(input, {
              automaticRemoteRefreshInterval: automaticGitFetchInterval,
            }),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshStatus,
            vcsStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsPull,
            gitWorkflow.pullCurrentBranch(input.cwd).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
              gitWorkflow
                .runStackedAction(input, {
                  actionId: input.actionId,
                  progressReporter: {
                    publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                  },
                })
                .pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) => Queue.failCause(queue, cause),
                    onSuccess: () =>
                      refreshGitStatus(input.cwd).pipe(
                        Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                      ),
                  }),
                ),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolvePullRequest,
            gitWorkflow.resolvePullRequest(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            gitWorkflow
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsListRefs]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListRefs, gitWorkflow.listRefs(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateWorktree,
            gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRemoveWorktree,
            gitWorkflow.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateRef,
            gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsSwitchRef,
            gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsInit,
            vcsProvisioning
              .initRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(
            WS_METHODS.terminalOpen,
            Effect.succeed({
              ...input,
              status: "disabled",
            }),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalWrite]: () =>
          observeRpcEffect(WS_METHODS.terminalWrite, Effect.void, {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalResize]: () =>
          observeRpcEffect(WS_METHODS.terminalResize, Effect.void, {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClear]: () =>
          observeRpcEffect(WS_METHODS.terminalClear, Effect.void, {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(
            WS_METHODS.terminalRestart,
            Effect.succeed({
              ...input,
              status: "disabled",
            }),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalClose]: () =>
          observeRpcEffect(WS_METHODS.terminalClose, Effect.void, {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.subscribeServerConfig]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              const providerStatuses = providerRegistry.streamChanges.pipe(
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );

              yield* providerRegistry
                .refresh()
                .pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(providerStatuses, settingsUpdates),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  type: "snapshot" as const,
                  config: yield* loadServerConfig,
                }),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = lifecycleEvents.stream.pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                BootstrapCredentialChange | SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
        [WS_METHODS.subscribeCadViewCommands]: (_input) =>
          observeRpcStream(WS_METHODS.subscribeCadViewCommands, cadViewCommandStream, {
            "rpc.aggregate": "cad",
          }),
        [WS_METHODS.subscribeCadHierarchyRequests]: (_input) =>
          observeRpcStream(WS_METHODS.subscribeCadHierarchyRequests, cadHierarchyRequestStream, {
            "rpc.aggregate": "cad",
          }),
        [WS_METHODS.subscribeCadScreenshotRequests]: (_input) =>
          observeRpcStream(WS_METHODS.subscribeCadScreenshotRequests, cadScreenshotRequestStream, {
            "rpc.aggregate": "cad",
          }),
      });
    }),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.succeed(
    HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request);
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
          disableTracing: true,
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(session.sessionId).pipe(
              Layer.provideMerge(RpcSerialization.layerJson),
              Layer.provide(ProviderMaintenanceRunner.layer),
              Layer.provide(
                SourceControlDiscoveryLayer.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(
                        Layer.mergeAll(
                          AzureDevOpsCli.layer,
                          BitbucketApi.layer,
                          GitHubCli.layer,
                          GitLabCli.layer,
                        ),
                      ),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                  Layer.provide(VcsProcess.layer),
                ),
              ),
            ),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
    ),
  ),
);
