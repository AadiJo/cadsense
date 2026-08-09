import Mime from "@effect/platform-node/Mime";
import { isOnshapeSyncRelativePath, isSupportedCadModelPath } from "@cadsense/shared/cad";
import {
  CadControlInput,
  CadHierarchyRequestInput,
  CadHierarchyUploadInput,
  CadScreenshotMcpCaptureInput,
  CadSetViewInput,
  OnshapeRpcError,
} from "@cadsense/contracts";
import { decodeOtlpTraceRecords } from "@cadsense/shared/observability";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
} from "effect/unstable/http";
import { OtlpTracer } from "effect/unstable/observability";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { resolveAttachmentPathById } from "./attachmentStore.ts";
import { resolveStaticDir, ServerConfig } from "./config.ts";
import { BrowserTraceCollector } from "./observability/Services/BrowserTraceCollector.ts";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver.ts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import { respondToAuthError } from "./auth/http.ts";
import {
  completeCadHierarchyRequest,
  publishCadControlCommand,
  publishCadViewCommand,
  requestCadHierarchy,
} from "./cad/CadViewCommands.ts";
import { resolveCadRequestThreadId } from "./cad/CadThreadAliases.ts";
import { captureCadScreenshot } from "./cad/CadScreenshotClient.ts";
import {
  CAD_HIERARCHY_HTTP_TIMEOUT_MS,
  CAD_VIEW_MCP_HTTP_PATH,
  CAD_VIEW_MCP_PROTOCOL_VERSION,
  CAD_VIEW_MCP_TOKEN,
  CAD_VIEW_MCP_TOKEN_HEADER,
  handleCadViewMcpRequest,
  parseCadViewMcpCapability,
} from "./cad/CadViewMcp.ts";
import {
  CAD_MODEL_HTTP_PATH,
  parseCadModelLeafFromPathname,
  posixFileBasename,
} from "./cad/cadModelHttpPath.ts";
import { MECHBASE_API_KEY_SECRET_NAME, fetchMechbaseArtifact } from "./mechbase/MechbaseApi.ts";
import { decodeMechbaseApiKey } from "./mechbase/MechbaseConnection.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import {
  browserApiCorsAllowedHeaders,
  browserApiCorsAllowedMethods,
  browserApiCorsHeaders,
} from "./httpCors.ts";

const PROJECT_FAVICON_CACHE_CONTROL = "public, max-age=3600";
const FALLBACK_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;
const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const CAD_VIEW_COMMAND_ROUTE_PATH = "/api/cad/view-command";
const CAD_CONTROL_ROUTE_PATH = "/api/cad/control-command";
const CAD_HIERARCHY_ROUTE_PATH = "/api/cad/hierarchy";
const CAD_HIERARCHY_UPLOAD_ROUTE_PATH = "/api/cad/hierarchy-upload";
const CAD_REVIEW_ARTIFACT_ROUTE_PATH = "/api/cad/review-artifact";
const MECHBASE_ARTIFACT_ROUTE_PATH = "/api/mechbase/artifact";
const CAD_SCREENSHOT_CAPTURE_ROUTE_PATH = "/api/cad/screenshot-capture";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const CAD_REVIEW_ARTIFACT_DIRECTORY_SEGMENT = "cadsense-cad-screenshots";
const CAD_REVIEW_ARTIFACT_IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const decodeCadSetViewInput = Schema.decodeUnknownEffect(CadSetViewInput);
const decodeCadControlInput = Schema.decodeUnknownEffect(CadControlInput);
const decodeCadHierarchyRequestInput = Schema.decodeUnknownEffect(CadHierarchyRequestInput);
const decodeCadHierarchyUploadInput = Schema.decodeUnknownEffect(CadHierarchyUploadInput);
const decodeCadScreenshotMcpCaptureInput = Schema.decodeUnknownEffect(CadScreenshotMcpCaptureInput);

function makeMechbaseApiKeySecretPath(secretsDir: string): string {
  return `${secretsDir.replace(/[\\/]+$/, "")}/${MECHBASE_API_KEY_SECRET_NAME}.bin`;
}

export const browserApiCorsLayer = HttpRouter.cors({
  allowedMethods: [...browserApiCorsAllowedMethods],
  allowedHeaders: [...browserApiCorsAllowedHeaders],
  maxAge: 600,
});

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const requireAuthenticatedRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  yield* serverAuth.authenticateHttpRequest(request);
});

const requireAuthenticatedOrCadMcpRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers[CAD_VIEW_MCP_TOKEN_HEADER] === CAD_VIEW_MCP_TOKEN) {
    return;
  }
  const serverAuth = yield* ServerAuth;
  yield* serverAuth.authenticateHttpRequest(request);
});

export const serverEnvironmentRouteLayer = HttpRouter.add(
  "GET",
  "/.well-known/cadsense/environment",
  Effect.gen(function* () {
    const descriptor = yield* Effect.service(ServerEnvironment).pipe(
      Effect.flatMap((serverEnvironment) => serverEnvironment.getDescriptor),
    );
    return HttpServerResponse.jsonUnsafe(descriptor, {
      status: 200,
      headers: browserApiCorsHeaders,
    });
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.text("Trace export failed.", { status: 502 })),
        ),
      );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const attachmentsRouteLayer = HttpRouter.add(
  "GET",
  `${ATTACHMENTS_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    const rawRelativePath = url.value.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
    const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
    if (!normalizedRelativePath) {
      return HttpServerResponse.text("Invalid attachment path", { status: 400 });
    }

    const isIdLookup =
      !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
    const filePath = isIdLookup
      ? resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: normalizedRelativePath,
        })
      : resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: normalizedRelativePath,
        });
    if (!filePath) {
      return HttpServerResponse.text(isIdLookup ? "Not Found" : "Invalid attachment path", {
        status: isIdLookup ? 404 : 400,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const projectFaviconRouteLayer = HttpRouter.add(
  "GET",
  "/api/project-favicon",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const projectCwd = url.value.searchParams.get("cwd");
    if (!projectCwd) {
      return HttpServerResponse.text("Missing cwd parameter", { status: 400 });
    }

    const faviconResolver = yield* ProjectFaviconResolver;
    const faviconFilePath = yield* faviconResolver.resolvePath(projectCwd);
    if (!faviconFilePath) {
      return HttpServerResponse.text(FALLBACK_PROJECT_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: {
          "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
        },
      });
    }

    return yield* HttpServerResponse.file(faviconFilePath, {
      status: 200,
      headers: {
        "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

function isCadReviewArtifactPath(pathService: Path.Path, candidate: string): boolean {
  if (candidate.includes("\0") || !pathService.isAbsolute(candidate)) {
    return false;
  }
  const normalizedParts = pathService
    .normalize(candidate)
    .split(/[\\/]+/)
    .map((part) => part.toLowerCase());
  if (!normalizedParts.includes(CAD_REVIEW_ARTIFACT_DIRECTORY_SEGMENT)) {
    return false;
  }
  return CAD_REVIEW_ARTIFACT_IMAGE_EXTENSIONS.has(pathService.extname(candidate).toLowerCase());
}

export const cadReviewArtifactRouteLayer = HttpRouter.add(
  "GET",
  CAD_REVIEW_ARTIFACT_ROUTE_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const artifactUri = url.value.searchParams.get("artifactUri");
    if (!artifactUri) {
      return HttpServerResponse.text("Missing artifactUri parameter", { status: 400 });
    }

    const pathService = yield* Path.Path;
    if (!isCadReviewArtifactPath(pathService, artifactUri)) {
      return HttpServerResponse.text("Unsupported CAD review artifact path", { status: 400 });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem
      .stat(artifactUri)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* HttpServerResponse.file(artifactUri, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const mechbaseArtifactRouteLayer = HttpRouter.add(
  "GET",
  MECHBASE_ARTIFACT_ROUTE_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const artifactUrl = url.value.searchParams.get("artifactUrl");
    if (!artifactUrl) {
      return HttpServerResponse.text("Missing artifactUrl parameter", { status: 400 });
    }

    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const storedApiKey = yield* fileSystem
      .readFile(makeMechbaseApiKeySecretPath(config.secretsDir))
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!storedApiKey) {
      return HttpServerResponse.text("Mechbase is not configured", { status: 404 });
    }

    const apiKey = decodeMechbaseApiKey(storedApiKey);
    const artifact = yield* Effect.tryPromise(() =>
      fetchMechbaseArtifact({ artifactUrl }, apiKey),
    ).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Mechbase artifact preview fetch failed", {
          artifactUrl,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed(error instanceof Error ? error.message : "Failed to fetch artifact"),
      ),
    );
    if (typeof artifact === "string") {
      return HttpServerResponse.text(artifact, { status: 400 });
    }

    return HttpServerResponse.uint8Array(artifact.data, {
      status: 200,
      contentType: artifact.mimeType,
      headers: {
        "Cache-Control": "private, max-age=3600",
      },
    });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

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

const cadModelFileHandler = Effect.gen(function* () {
  yield* requireAuthenticatedRequest;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }

  const cwd = url.value.searchParams.get("cwd");
  const relativePath = url.value.searchParams.get("path");
  if (!cwd || !relativePath) {
    return HttpServerResponse.text("Missing cwd or path parameter", { status: 400 });
  }

  const normalizedRelativePath = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    normalizedRelativePath.length === 0 ||
    normalizedRelativePath.includes("\0") ||
    !isOnshapeSyncRelativePath(normalizedRelativePath) ||
    !isSupportedCadModelPath(normalizedRelativePath)
  ) {
    return HttpServerResponse.text("Unsupported CAD model path", { status: 400 });
  }

  const urlLeaf = parseCadModelLeafFromPathname(url.value.pathname);
  const expectedLeaf = posixFileBasename(normalizedRelativePath);
  if (urlLeaf !== null && urlLeaf !== expectedLeaf) {
    return HttpServerResponse.text("CAD model path does not match URL file name", { status: 400 });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const workspaceRoot = pathService.resolve(cwd);
  const cadSyncRoot = pathService.resolve(workspaceRoot, "onshape-sync");
  const filePath = pathService.resolve(workspaceRoot, normalizedRelativePath);
  if (!isWithinRoot(pathService, cadSyncRoot, filePath)) {
    return HttpServerResponse.text("Invalid CAD model path", { status: 400 });
  }

  const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (!fileInfo || fileInfo.type !== "File") {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }

  const contentType = Mime.getType(filePath) ?? "application/octet-stream";
  const cacheControl = url.value.searchParams.has("v")
    ? "public, max-age=31536000, immutable"
    : "no-cache";

  return yield* HttpServerResponse.file(filePath, {
    status: 200,
    headers: {
      "Cache-Control": cacheControl,
      "Content-Type": contentType,
    },
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
    ),
  );
}).pipe(Effect.catchTag("AuthError", respondToAuthError));

/** Single wildcard route: find-my-way rejects registering both `/cad-model` and `/cad-model/*` for the same method. */
export const cadModelFileRouteLayer = HttpRouter.add(
  "GET",
  `${CAD_MODEL_HTTP_PATH}/*`,
  cadModelFileHandler,
);

export const cadSetViewRouteLayer = HttpRouter.add(
  "POST",
  CAD_VIEW_COMMAND_ROUTE_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedOrCadMcpRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json;
    const rawInput = yield* decodeCadSetViewInput(body).pipe(
      Effect.mapError(() => "invalid" as const),
    );
    const threadId = resolveCadRequestThreadId(rawInput.threadId);
    const input: CadSetViewInput = { ...rawInput, threadId };
    const command = yield* publishCadViewCommand(input);
    return HttpServerResponse.jsonUnsafe(command, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchIf(
      (error): error is "invalid" => error === "invalid",
      () => Effect.succeed(HttpServerResponse.text("Invalid CAD view command", { status: 400 })),
    ),
  ),
);

export const cadControlRouteLayer = HttpRouter.add(
  "POST",
  CAD_CONTROL_ROUTE_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedOrCadMcpRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json;
    const rawInput = yield* decodeCadControlInput(body).pipe(
      Effect.mapError(() => "invalid" as const),
    );
    const threadId = resolveCadRequestThreadId(rawInput.threadId);
    const input: CadControlInput = { ...rawInput, threadId };
    const command = yield* publishCadControlCommand(input);
    return HttpServerResponse.jsonUnsafe(command, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchIf(
      (error): error is "invalid" => error === "invalid",
      () => Effect.succeed(HttpServerResponse.text("Invalid CAD control command", { status: 400 })),
    ),
  ),
);

export const cadHierarchyRouteLayer = HttpRouter.add(
  "POST",
  CAD_HIERARCHY_ROUTE_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedOrCadMcpRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json;
    const rawInput = yield* decodeCadHierarchyRequestInput(body).pipe(
      Effect.mapError(() => "invalid" as const),
    );
    const threadId = resolveCadRequestThreadId(rawInput.threadId);
    const result = yield* Effect.race(
      requestCadHierarchy(threadId).pipe(
        Effect.mapError(
          (cause) =>
            new OnshapeRpcError({
              message: cause.message || "CAD hierarchy request failed.",
              cause,
            }),
        ),
      ),
      Effect.sleep(`${CAD_HIERARCHY_HTTP_TIMEOUT_MS} millis`).pipe(
        Effect.flatMap(() =>
          Effect.fail(new OnshapeRpcError({ message: "CAD hierarchy timed out." })),
        ),
      ),
    );
    return HttpServerResponse.jsonUnsafe(result, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchIf(
      (error): error is "invalid" => error === "invalid",
      () =>
        Effect.succeed(HttpServerResponse.text("Invalid CAD hierarchy request", { status: 400 })),
    ),
    Effect.catchTag("OnshapeRpcError", (error) =>
      Effect.succeed(HttpServerResponse.text(error.message, { status: 504 })),
    ),
  ),
);

export const cadHierarchyUploadRouteLayer = HttpRouter.add(
  "POST",
  CAD_HIERARCHY_UPLOAD_ROUTE_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedOrCadMcpRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json;
    const input = yield* decodeCadHierarchyUploadInput(body).pipe(
      Effect.mapError(() => "invalid" as const),
    );
    const completed = completeCadHierarchyRequest(
      input.requestId,
      { responderId: input.responderId, leaseId: input.leaseId },
      {
        components: input.components,
        ...(input.status ? { status: input.status } : {}),
        ...(input.message ? { message: input.message } : {}),
      },
    );
    if (!completed) {
      return HttpServerResponse.text("Unknown, expired, or unclaimed CAD hierarchy request", {
        status: 409,
      });
    }
    return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchIf(
      (error): error is "invalid" => error === "invalid",
      () =>
        Effect.succeed(HttpServerResponse.text("Invalid CAD hierarchy upload", { status: 400 })),
    ),
  ),
);

export const cadScreenshotCaptureRouteLayer = HttpRouter.add(
  "POST",
  CAD_SCREENSHOT_CAPTURE_ROUTE_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedOrCadMcpRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const pathService = yield* Path.Path;
    const body = yield* request.json;
    const rawInput = yield* decodeCadScreenshotMcpCaptureInput(body).pipe(
      Effect.mapError(() => "invalid" as const),
    );
    const threadId = resolveCadRequestThreadId(rawInput.threadId);
    const input: CadScreenshotMcpCaptureInput = { ...rawInput, threadId };
    const exportRootRaw = input.exportRoot.trim();
    if (
      exportRootRaw.length === 0 ||
      exportRootRaw.includes("\0") ||
      !pathService.isAbsolute(exportRootRaw)
    ) {
      return HttpServerResponse.text("exportRoot must be a non-empty absolute path", {
        status: 400,
      });
    }
    const exportRootResolved = pathService.resolve(exportRootRaw);
    return yield* captureCadScreenshot({
      threadId: input.threadId,
      exportRoot: exportRootResolved,
      suggestedBaseName: input.suggestedBaseName,
      view: input.view,
      fit: input.fit,
    }).pipe(
      Effect.matchEffect({
        onFailure: (e) => Effect.succeed(HttpServerResponse.text(e.message, { status: 504 })),
        onSuccess: (body) => Effect.succeed(HttpServerResponse.jsonUnsafe(body, { status: 200 })),
      }),
    );
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchIf(
      (error): error is "invalid" => error === "invalid",
      () =>
        Effect.succeed(
          HttpServerResponse.text("Invalid CAD screenshot capture payload", { status: 400 }),
        ),
    ),
  ),
);

function cadMcpJsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export const cadMcpRouteLayer = HttpRouter.add(
  "POST",
  CAD_VIEW_MCP_HTTP_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const capability = parseCadViewMcpCapability(request.headers[CAD_VIEW_MCP_TOKEN_HEADER]);
    if (!capability) return HttpServerResponse.text("Unauthorized", { status: 401 });

    const body = yield* request.json.pipe(Effect.mapError(() => "invalid-json" as const));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return HttpServerResponse.jsonUnsafe(cadMcpJsonRpcError(null, -32600, "Invalid Request"), {
        status: 400,
      });
    }
    const rpcRequest = body as {
      readonly id?: unknown;
      readonly method?: unknown;
      readonly params?: unknown;
    };
    const protocolVersion = request.headers["mcp-protocol-version"];
    if (protocolVersion === CAD_VIEW_MCP_PROTOCOL_VERSION) {
      const method = typeof rpcRequest.method === "string" ? rpcRequest.method : "";
      const params =
        rpcRequest.params && typeof rpcRequest.params === "object"
          ? (rpcRequest.params as Record<string, unknown>)
          : undefined;
      const expectedName = method === "tools/call" ? params?.name : undefined;
      if (
        request.headers["mcp-method"] !== method ||
        (typeof expectedName === "string" && request.headers["mcp-name"] !== expectedName)
      ) {
        return HttpServerResponse.jsonUnsafe(
          cadMcpJsonRpcError(
            rpcRequest.id ?? null,
            -32020,
            "MCP headers do not match the request.",
          ),
          { status: 400 },
        );
      }
    }

    const runtimeContext = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtimeContext);
    const response = yield* Effect.tryPromise(() =>
      handleCadViewMcpRequest(
        rpcRequest,
        {
          setView: (input) => runPromise(publishCadViewCommand(input).pipe(Effect.asVoid)),
          sendControl: (input) => runPromise(publishCadControlCommand(input).pipe(Effect.asVoid)),
          getHierarchy: (input) =>
            runPromise(
              Effect.race(
                requestCadHierarchy(input.threadId),
                Effect.sleep(`${CAD_HIERARCHY_HTTP_TIMEOUT_MS} millis`).pipe(
                  Effect.flatMap(() =>
                    Effect.fail(new OnshapeRpcError({ message: "CAD hierarchy timed out." })),
                  ),
                ),
              ),
            ),
          captureScreenshot: (input) =>
            runPromise(
              captureCadScreenshot({
                threadId: input.threadId,
                exportRoot: input.exportRoot,
                suggestedBaseName: input.suggestedBaseName,
                view: input.view,
                fit: input.fit,
              }),
            ),
        },
        { ...capability, ...(protocolVersion ? { protocolVersion } : {}) },
      ),
    );
    return response === null
      ? HttpServerResponse.empty({ status: 202 })
      : HttpServerResponse.jsonUnsafe(response, { status: 200 });
  }).pipe(
    Effect.catchIf(
      (error): error is "invalid-json" => error === "invalid-json",
      () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(cadMcpJsonRpcError(null, -32700, "Parse error"), {
            status: 400,
          }),
        ),
    ),
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          cadMcpJsonRpcError(null, -32603, error instanceof Error ? error.message : String(error)),
          { status: 500 },
        ),
      ),
    ),
  ),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir = config.staticDir ?? (config.devUrl ? yield* resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      return yield* HttpServerResponse.file(indexPath, {
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: browserApiCorsHeaders,
      }).pipe(
        Effect.catch(() => Effect.succeed(HttpServerResponse.text("Not Found", { status: 404 }))),
      );
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      contentType,
      headers: browserApiCorsHeaders,
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }),
);
