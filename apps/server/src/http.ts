import Mime from "@effect/platform-node/Mime";
import { isOnshapeSyncRelativePath, isSupportedCadModelPath } from "@cadsense/shared/cad";
import {
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
import { publishCadViewCommand } from "./cad/CadViewCommands.ts";
import {
  CAPTURE_TIMEOUT,
  publishCadScreenshotRequest,
  rejectCadScreenshotPending,
  startCadScreenshotCaptureEffect,
} from "./cad/CadScreenshotCapture.ts";
import { CAD_VIEW_MCP_TOKEN, CAD_VIEW_MCP_TOKEN_HEADER } from "./cad/CadViewMcp.ts";
import {
  CAD_MODEL_HTTP_PATH,
  parseCadModelLeafFromPathname,
  posixFileBasename,
} from "./cad/cadModelHttpPath.ts";
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
const CAD_SCREENSHOT_CAPTURE_ROUTE_PATH = "/api/cad/screenshot-capture";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const decodeCadSetViewInput = Schema.decodeUnknownEffect(CadSetViewInput);
const decodeCadScreenshotMcpCaptureInput = Schema.decodeUnknownEffect(CadScreenshotMcpCaptureInput);
const isOnshapeRpcError = Schema.is(OnshapeRpcError);

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
    const input = yield* decodeCadSetViewInput(body).pipe(
      Effect.mapError(() => "invalid" as const),
    );
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

export const cadScreenshotCaptureRouteLayer = HttpRouter.add(
  "POST",
  CAD_SCREENSHOT_CAPTURE_ROUTE_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedOrCadMcpRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const pathService = yield* Path.Path;
    const body = yield* request.json;
    const input = yield* decodeCadScreenshotMcpCaptureInput(body).pipe(
      Effect.mapError(() => "invalid" as const),
    );
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
    const capture = yield* startCadScreenshotCaptureEffect({
      threadId: input.threadId,
      exportRoot: exportRootResolved,
      suggestedBaseName: input.suggestedBaseName,
      view: input.view,
      fit: input.fit,
    });
    yield* publishCadScreenshotRequest(capture.browserRequest);
    return yield* Effect.race(
      capture.awaitResult,
      Effect.sleep(CAPTURE_TIMEOUT).pipe(
        Effect.tap(() =>
          Effect.sync(() =>
            rejectCadScreenshotPending(capture.requestId, "CAD screenshot capture timed out."),
          ),
        ),
        Effect.flatMap(() =>
          Effect.fail(new OnshapeRpcError({ message: "CAD screenshot capture timed out." })),
        ),
      ),
    ).pipe(
      Effect.matchEffect({
        onFailure: (e) =>
          Effect.succeed(
            HttpServerResponse.text(
              isOnshapeRpcError(e)
                ? e.message
                : e instanceof Error
                  ? e.message
                  : "CAD screenshot capture failed.",
              { status: 504 },
            ),
          ),
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
