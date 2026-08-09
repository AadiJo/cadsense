// @effect-diagnostics nodeBuiltinImport:off
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stdio from "effect/Stdio";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { existsSync, readFileSync } from "node:fs";
import * as NodePath from "node:path";

import * as CodexRpc from "./_generated/meta.gen.ts";
import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import {
  decodeNotificationPayload,
  decodeOptionalPayload,
  encodeOptionalPayload,
  runHandler,
} from "./_internal/shared.ts";
import { makeChildStdio, makeTerminationError } from "./_internal/stdio.ts";

const DEFAULT_APP_SERVER_FORCE_KILL_AFTER = "2 seconds" as const;

export interface CodexAppServerClientOptions {
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (
    event: CodexProtocol.CodexAppServerProtocolLogEvent,
  ) => Effect.Effect<void, never>;
}

interface CodexAppServerClientRaw {
  readonly notifications: CodexProtocol.CodexAppServerPatchedProtocol["incomingNotifications"];
  readonly requests: CodexProtocol.CodexAppServerPatchedProtocol["incomingRequests"];
  readonly request: CodexProtocol.CodexAppServerPatchedProtocol["request"];
  readonly notify: CodexProtocol.CodexAppServerPatchedProtocol["notify"];
  readonly respond: CodexProtocol.CodexAppServerPatchedProtocol["respond"];
  readonly respondError: CodexProtocol.CodexAppServerPatchedProtocol["respondError"];
}

export interface CodexAppServerClientShape {
  readonly raw: CodexAppServerClientRaw;
  readonly request: <M extends CodexRpc.ClientRequestMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexError.CodexAppServerError>;
  readonly notify: <M extends CodexRpc.ClientNotificationMethod>(
    method: M,
    payload: CodexRpc.ClientNotificationParamsByMethod[M],
  ) => Effect.Effect<void, CodexError.CodexAppServerError>;
  readonly handleServerRequest: <M extends CodexRpc.ServerRequestMethod>(
    method: M,
    handler: (
      payload: CodexRpc.ServerRequestParamsByMethod[M],
    ) => Effect.Effect<CodexRpc.ServerRequestResponsesByMethod[M], CodexError.CodexAppServerError>,
  ) => Effect.Effect<void>;
  readonly handleServerNotification: <M extends CodexRpc.ServerNotificationMethod>(
    method: M,
    handler: (
      payload: CodexRpc.ServerNotificationParamsByMethod[M],
    ) => Effect.Effect<void, CodexError.CodexAppServerError>,
  ) => Effect.Effect<void>;
  readonly handleUnknownServerRequest: (
    handler: (
      method: string,
      params: unknown,
    ) => Effect.Effect<unknown, CodexError.CodexAppServerError>,
  ) => Effect.Effect<void>;
  readonly handleUnknownServerNotification: (
    handler: (
      method: string,
      params: unknown,
    ) => Effect.Effect<void, CodexError.CodexAppServerError>,
  ) => Effect.Effect<void>;
}

export class CodexAppServerClient extends Context.Service<
  CodexAppServerClient,
  CodexAppServerClientShape
>()("effect-codex-app-server/CodexAppServerClient") {}

type ServerRequestHandler = (
  payload: unknown,
) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
type ServerNotificationHandler = (
  payload: unknown,
) => Effect.Effect<void, CodexError.CodexAppServerError>;

const CODEX_NOTIFICATION_DECODE_FAILURE_MARKER = "__codexNotificationDecodeFailure";

export const make = Effect.fn("effect-codex-app-server/CodexAppServerClient.make")(function* (
  stdio: Stdio.Stdio,
  options: CodexAppServerClientOptions = {},
  terminationError?: Effect.Effect<CodexError.CodexAppServerError>,
): Effect.fn.Return<CodexAppServerClientShape, never, Scope.Scope> {
  const requestHandlers = new Map<string, ServerRequestHandler>();
  const notificationHandlers = new Map<string, Array<ServerNotificationHandler>>();
  let unknownRequestHandler:
    | ((method: string, params: unknown) => Effect.Effect<unknown, CodexError.CodexAppServerError>)
    | undefined;
  let unknownNotificationHandler:
    | ((method: string, params: unknown) => Effect.Effect<void, CodexError.CodexAppServerError>)
    | undefined;

  const getServerRequestParamSchema = <M extends CodexRpc.ServerRequestMethod>(
    method: M,
  ):
    | Schema.Codec<CodexRpc.ServerRequestParamsByMethod[M], CodexRpc.ServerRequestParamsByMethod[M]>
    | undefined => CodexRpc.SERVER_REQUEST_PARAMS[method] as never;

  const getServerRequestResponseSchema = <M extends CodexRpc.ServerRequestMethod>(
    method: M,
  ):
    | Schema.Codec<
        CodexRpc.ServerRequestResponsesByMethod[M],
        CodexRpc.ServerRequestResponsesByMethod[M]
      >
    | undefined => CodexRpc.SERVER_REQUEST_RESPONSES[method] as never;

  const getClientRequestParamSchema = <M extends CodexRpc.ClientRequestMethod>(
    method: M,
  ):
    | Schema.Codec<CodexRpc.ClientRequestParamsByMethod[M], CodexRpc.ClientRequestParamsByMethod[M]>
    | undefined => CodexRpc.CLIENT_REQUEST_PARAMS[method] as never;

  const getClientRequestResponseSchema = <M extends CodexRpc.ClientRequestMethod>(
    method: M,
  ):
    | Schema.Codec<
        CodexRpc.ClientRequestResponsesByMethod[M],
        CodexRpc.ClientRequestResponsesByMethod[M]
      >
    | undefined => CodexRpc.CLIENT_REQUEST_RESPONSES[method] as never;

  const getClientNotificationParamSchema = <M extends CodexRpc.ClientNotificationMethod>(
    method: M,
  ):
    | Schema.Codec<
        CodexRpc.ClientNotificationParamsByMethod[M],
        CodexRpc.ClientNotificationParamsByMethod[M]
      >
    | undefined => CodexRpc.CLIENT_NOTIFICATION_PARAMS[method] as never;

  const dispatchNotification = (
    notification: CodexProtocol.CodexAppServerIncomingNotification,
  ): Effect.Effect<void, never> => {
    const schema =
      notification.method in CodexRpc.SERVER_NOTIFICATION_PARAMS
        ? CodexRpc.SERVER_NOTIFICATION_PARAMS[
            notification.method as CodexRpc.ServerNotificationMethod
          ]
        : undefined;
    const handlers = notificationHandlers.get(notification.method) ?? [];

    if (schema) {
      return decodeNotificationPayload(notification.method, schema, notification.params).pipe(
        Effect.flatMap((decoded) =>
          Effect.forEach(handlers, (handler) => handler(decoded), { discard: true }),
        ),
        Effect.catchTag("CodexAppServerProtocolParseError", (error) =>
          Effect.andThen(
            Effect.logWarning(
              "Codex App Server notification failed schema decode; forwarding protocol warning payload to handlers",
              {
                method: notification.method,
                detail: error.detail,
              },
            ),
            Effect.forEach(
              handlers,
              (handler) =>
                handler({
                  [CODEX_NOTIFICATION_DECODE_FAILURE_MARKER]: true,
                  method: notification.method,
                  detail: error.detail,
                  rawParams: notification.params,
                } as never),
              {
                discard: true,
              },
            ),
          ),
        ),
        Effect.catch(() => Effect.void),
      );
    }

    return unknownNotificationHandler
      ? unknownNotificationHandler(notification.method, notification.params).pipe(
          Effect.catch(() => Effect.void),
        )
      : Effect.void;
  };

  const dispatchRequest = (
    request: CodexProtocol.CodexAppServerIncomingRequest,
  ): Effect.Effect<unknown, CodexError.CodexAppServerError> => {
    if (request.method in CodexRpc.SERVER_REQUEST_PARAMS) {
      const method = request.method as CodexRpc.ServerRequestMethod;
      const payloadSchema = getServerRequestParamSchema(method);
      const responseSchema = getServerRequestResponseSchema(method);
      const handler = requestHandlers.get(method);

      return decodeOptionalPayload(method, payloadSchema, request.params).pipe(
        Effect.flatMap((decoded) => runHandler(handler, decoded, method)),
        Effect.flatMap((result) => encodeOptionalPayload(method, responseSchema, result)),
      );
    }

    return unknownRequestHandler
      ? unknownRequestHandler(request.method, request.params)
      : Effect.fail(CodexError.CodexAppServerRequestError.methodNotFound(request.method));
  };

  const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
    stdio,
    ...(terminationError ? { terminationError } : {}),
    ...(options.logIncoming !== undefined ? { logIncoming: options.logIncoming } : {}),
    ...(options.logOutgoing !== undefined ? { logOutgoing: options.logOutgoing } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    onNotification: dispatchNotification,
    onRequest: dispatchRequest,
  });

  const request = <M extends CodexRpc.ClientRequestMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ): Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexError.CodexAppServerError> =>
    encodeOptionalPayload(method, getClientRequestParamSchema(method), payload).pipe(
      Effect.flatMap((encoded) => transport.request(method, encoded)),
      Effect.flatMap(
        (
          raw,
        ): Effect.Effect<
          CodexRpc.ClientRequestResponsesByMethod[M],
          CodexError.CodexAppServerError
        > => decodeOptionalPayload(method, getClientRequestResponseSchema(method), raw),
      ),
    );

  const notify = <M extends CodexRpc.ClientNotificationMethod>(
    method: M,
    payload: CodexRpc.ClientNotificationParamsByMethod[M],
  ) =>
    encodeOptionalPayload(method, getClientNotificationParamSchema(method), payload).pipe(
      Effect.flatMap((encoded) => transport.notify(method, encoded)),
    );

  return CodexAppServerClient.of({
    raw: {
      notifications: transport.incomingNotifications,
      requests: transport.incomingRequests,
      request: transport.request,
      notify: transport.notify,
      respond: transport.respond,
      respondError: transport.respondError,
    },
    request,
    notify,
    handleServerRequest: (method, handler) =>
      Effect.sync(() => {
        requestHandlers.set(method, handler as ServerRequestHandler);
      }),
    handleServerNotification: (method, handler) =>
      Effect.sync(() => {
        const current = notificationHandlers.get(method) ?? [];
        current.push(handler as ServerNotificationHandler);
        notificationHandlers.set(method, current);
      }),
    handleUnknownServerRequest: (handler) =>
      Effect.sync(() => {
        unknownRequestHandler = handler;
      }),
    handleUnknownServerNotification: (handler) =>
      Effect.sync(() => {
        unknownNotificationHandler = handler;
      }),
  });
});

export const layerChildProcess = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: CodexAppServerClientOptions = {},
): Layer.Layer<CodexAppServerClient> => {
  const stdio = makeChildStdio(handle);
  const terminationError = makeTerminationError(handle);
  return Layer.effect(CodexAppServerClient, make(stdio, options, terminationError));
};

export interface CodexAppServerCommandLayerOptions extends CodexAppServerClientOptions {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

interface ResolvedSpawnCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

function readWindowsEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function resolveWindowsCommandPath(
  command: string,
  cwd: string,
  env: Record<string, string | undefined>,
): string | null {
  const hasPathSegment = command.includes("/") || command.includes("\\");
  const searchDirectories = hasPathSegment
    ? [NodePath.win32.resolve(cwd, NodePath.win32.dirname(command))]
    : (readWindowsEnv(env, "PATH") ?? "").split(";").filter((entry) => entry.length > 0);
  const commandName = hasPathSegment ? NodePath.win32.basename(command) : command;
  const extensions = NodePath.win32.extname(commandName)
    ? [""]
    : (readWindowsEnv(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";");

  for (const directory of searchDirectories) {
    for (const extension of extensions) {
      const candidate = NodePath.win32.join(directory, `${commandName}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolveWindowsCommandShim(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string | undefined>,
  depth = 0,
): ResolvedSpawnCommand {
  if (depth > 5) return { command, args };
  const resolvedPath = resolveWindowsCommandPath(command, cwd, env);
  if (!resolvedPath || !/\.(?:cmd|bat)$/i.test(resolvedPath)) {
    return { command: resolvedPath ?? command, args };
  }

  try {
    const source = readFileSync(resolvedPath, "utf8");
    const npmScript = source.match(/["']%dp0%[\\/]([^"'\r\n]+\.js)["']\s+%\*/i)?.[1];
    if (npmScript) {
      const scriptPath = NodePath.win32.resolve(NodePath.win32.dirname(resolvedPath), npmScript);
      if (existsSync(scriptPath)) {
        const adjacentNode = NodePath.win32.join(NodePath.win32.dirname(resolvedPath), "node.exe");
        return {
          command: existsSync(adjacentNode) ? adjacentNode : process.execPath,
          args: [scriptPath, ...args],
        };
      }
    }

    const forwardingShim = source.match(/^\s*["']([^"'\r\n]+\.(?:cmd|bat))["']\s+%\*\s*$/im)?.[1];
    if (forwardingShim) {
      return resolveWindowsCommandShim(forwardingShim, args, cwd, env, depth + 1);
    }
  } catch {
    // Preserve the normal spawn error when a shim cannot be inspected.
  }
  return { command: resolvedPath, args };
}

export function resolveCommandForSpawn(
  options: Pick<CodexAppServerCommandLayerOptions, "command" | "args" | "cwd" | "env">,
  platform: NodeJS.Platform = process.platform,
): ResolvedSpawnCommand {
  const args = options.args ?? [];
  if (platform !== "win32") return { command: options.command, args };
  const env = { ...process.env, ...options.env };
  return resolveWindowsCommandShim(options.command, args, options.cwd ?? process.cwd(), env);
}

export const layerCommand = (
  options: CodexAppServerCommandLayerOptions,
): Layer.Layer<
  CodexAppServerClient,
  CodexError.CodexAppServerSpawnError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effect(
    CodexAppServerClient,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const resolved = resolveCommandForSpawn(options);
      const command = ChildProcess.make(resolved.command, [...resolved.args], {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
        forceKillAfter: DEFAULT_APP_SERVER_FORCE_KILL_AFTER,
        // Keep command arguments out of a command shell. In particular, provider
        // settings can contain user-controlled paths and arguments that must be
        // passed verbatim rather than interpreted as cmd.exe syntax on Windows.
        shell: false,
      });
      return yield* spawner.spawn(command).pipe(
        Effect.mapError(
          (cause) =>
            new CodexError.CodexAppServerSpawnError({
              command: [options.command, ...(options.args ?? [])].join(" "),
              cause,
            }),
        ),
      );
    }).pipe(
      Effect.flatMap((handle) =>
        make(makeChildStdio(handle), options, makeTerminationError(handle)),
      ),
    ),
  );
