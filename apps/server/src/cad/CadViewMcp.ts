import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  CadScreenshotMcpCaptureInput,
  CadSetViewInput,
  CadView,
  ThreadId,
  type CadScreenshotCaptureHttpResult,
} from "@cadsense/contracts";
import { CAD_VIEW_ORIENTATION_GUIDE } from "@cadsense/shared/cadViewOrientationGuide";
import * as Schema from "effect/Schema";

import type { ServerConfigShape } from "../config.ts";
import { formatHostForUrl, isWildcardHost } from "../startupAccess.ts";

export const CAD_VIEW_MCP_SERVER_NAME = "cadsense-cad-view";
export const CAD_VIEW_MCP_TOOL_NAME = "set_cad_view";
export const CAD_VIEW_MCP_EXPORT_TOOL_NAME = "export_cad_screenshot";
export const CAD_VIEW_MCP_TOKEN_HEADER = "x-cadsense-cad-view-token";
export const CAD_VIEW_MCP_TOKEN = randomUUID();
export const CAD_VIEW_EXPORT_ROOT_ENV = "CADSENSE_CAD_VIEW_EXPORT_ROOT";

const CAD_VIEW_VALUES = [
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
] as const satisfies ReadonlyArray<CadView>;

const isCadSetViewInput = Schema.is(CadSetViewInput);
const isCadView = Schema.is(CadView);
const isCadScreenshotMcpCaptureInput = Schema.is(CadScreenshotMcpCaptureInput);
const decodeThreadIdUnknownSync = Schema.decodeUnknownSync(ThreadId);

const SET_CAD_VIEW_TOOL_DESCRIPTION = [
  "Set the CAD side panel camera view for the user. Use before answering spatial questions about the synchronized Onshape model shown in the web UI.",
  "Use -close-up presets when a detail view is needed without changing the underlying orientation.",
  "",
  "View reference:",
  CAD_VIEW_ORIENTATION_GUIDE,
].join("\n");

const EXPORT_CAD_SCREENSHOT_TOOL_DESCRIPTION = [
  "Capture a PNG screenshot of the CAD side panel (the live WebGL view of the synced assembly/model) and save it under the Codex export directory.",
  `Files are written to ${CAD_VIEW_EXPORT_ROOT_ENV}/<threadId>/ (by default the cadsense-cad-screenshots folder inside the configured Codex home or shadow home).`,
  "The agent can read the returned absolute path with normal file tools.",
  "Optional `view` applies that fixed camera first (same names as set_cad_view, including -close-up detail presets). Omit `view` to capture the user's current camera.",
  "",
  "View reference:",
  CAD_VIEW_ORIENTATION_GUIDE,
].join("\n");

function resolveCadSenseMainScriptForMcpChild(): string {
  const fromArgv = process.argv[1];
  if (typeof fromArgv === "string" && fromArgv.length > 0 && !fromArgv.startsWith("-")) {
    return fromArgv;
  }
  return fileURLToPath(import.meta.url);
}

export function makeCadViewMcpOrigin(config: Pick<ServerConfigShape, "host" | "port">): string {
  const hostname =
    config.host && !isWildcardHost(config.host) ? formatHostForUrl(config.host) : "127.0.0.1";
  return `http://${hostname}:${config.port}`;
}

export function makeCadViewMcpEnv(
  config: Pick<ServerConfigShape, "host" | "port">,
  threadId?: string,
  exportRoot?: string,
): Record<string, string> {
  // When this server is itself running under Electron with
  // `ELECTRON_RUN_AS_NODE=1`, `process.execPath` is the Electron binary.
  // Codex (and other agents) pass our `env` block verbatim to the spawned
  // MCP child without inheriting the parent's environment, so without
  // re-asserting `ELECTRON_RUN_AS_NODE=1` the child Electron starts as a
  // GUI app, exits immediately, and the agent only sees an `rmcp`
  // "EOF while parsing a value at line 1 column 0" error. Propagating the
  // flag keeps the child running as Node and the MCP transport healthy.
  const electronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  return {
    CADSENSE_CAD_VIEW_ORIGIN: makeCadViewMcpOrigin(config),
    CADSENSE_CAD_VIEW_TOKEN: CAD_VIEW_MCP_TOKEN,
    ...(threadId ? { CADSENSE_CAD_VIEW_THREAD_ID: threadId } : {}),
    ...(exportRoot && exportRoot.trim().length > 0
      ? { [CAD_VIEW_EXPORT_ROOT_ENV]: exportRoot.trim() }
      : {}),
    ...(electronRunAsNode ? { ELECTRON_RUN_AS_NODE: electronRunAsNode } : {}),
  };
}

export function makeCadViewMcpStdioServer(
  config: Pick<ServerConfigShape, "host" | "port">,
  threadId?: string,
  exportRoot?: string,
): {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
} {
  const env = makeCadViewMcpEnv(config, threadId, exportRoot);
  return {
    name: CAD_VIEW_MCP_SERVER_NAME,
    command: process.execPath,
    args: [resolveCadSenseMainScriptForMcpChild(), "mcp", "cad-view"],
    env: Object.entries(env).map(([name, value]) => ({ name, value })),
  };
}

export function makeCadViewCodexMcpConfig(
  config: Pick<ServerConfigShape, "host" | "port">,
  threadId?: string,
  exportRoot?: string,
): Record<string, unknown> {
  const server = makeCadViewMcpStdioServer(config, threadId, exportRoot);
  return {
    mcp_servers: {
      [CAD_VIEW_MCP_SERVER_NAME]: {
        command: server.command,
        args: server.args,
        env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
      },
    },
  };
}

export function makeCadViewClaudeMcpServers(
  config: Pick<ServerConfigShape, "host" | "port">,
  threadId?: string,
  exportRoot?: string,
): Record<
  string,
  {
    readonly command: string;
    readonly args: string[];
    readonly env: Record<string, string>;
  }
> {
  const server = makeCadViewMcpStdioServer(config, threadId, exportRoot);
  return {
    [CAD_VIEW_MCP_SERVER_NAME]: {
      command: server.command,
      args: [...server.args],
      env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
    },
  };
}

type JsonRpcRequest = {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
};

type JsonRpcResponse = Record<string, unknown>;

function jsonRpcResult(id: unknown, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: unknown, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function normalizeSetViewArguments(args: unknown): CadSetViewInput | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const candidate = args as Record<string, unknown>;
  const input = {
    threadId: candidate.threadId ?? process.env.CADSENSE_CAD_VIEW_THREAD_ID,
    view: candidate.view,
    fit: candidate.fit,
  };
  if (!isCadSetViewInput(input)) {
    return undefined;
  }
  return {
    threadId: input.threadId,
    view: input.view,
    fit: input.fit,
  };
}

function normalizeExportScreenshotArguments(
  args: unknown,
): CadScreenshotMcpCaptureInput | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const candidate = args as Record<string, unknown>;
  const exportRoot = process.env[CAD_VIEW_EXPORT_ROOT_ENV]?.trim();
  if (!exportRoot) {
    return undefined;
  }
  const threadIdRaw = candidate.threadId ?? process.env.CADSENSE_CAD_VIEW_THREAD_ID;
  if (typeof threadIdRaw !== "string") {
    return undefined;
  }
  let threadId: Schema.Schema.Type<typeof ThreadId>;
  try {
    threadId = decodeThreadIdUnknownSync(threadIdRaw);
  } catch {
    return undefined;
  }
  const viewRaw = candidate.view;
  const view = viewRaw === undefined ? undefined : isCadView(viewRaw) ? viewRaw : undefined;
  if (viewRaw !== undefined && view === undefined) {
    return undefined;
  }
  if (candidate.fit !== undefined && typeof candidate.fit !== "boolean") {
    return undefined;
  }
  const fit: boolean = candidate.fit === undefined ? true : candidate.fit;
  const suggestedBaseName =
    candidate.suggestedBaseName === undefined
      ? undefined
      : typeof candidate.suggestedBaseName === "string"
        ? candidate.suggestedBaseName
        : undefined;
  if (candidate.suggestedBaseName !== undefined && suggestedBaseName === undefined) {
    return undefined;
  }
  const assembled: CadScreenshotMcpCaptureInput = {
    threadId,
    exportRoot,
    view,
    fit,
    suggestedBaseName,
  };
  return isCadScreenshotMcpCaptureInput(assembled) ? assembled : undefined;
}

export interface CadViewMcpHandlers {
  readonly setView: (input: CadSetViewInput) => Promise<void>;
  readonly captureScreenshot: (
    input: CadScreenshotMcpCaptureInput,
  ) => Promise<CadScreenshotCaptureHttpResult>;
}

export async function handleCadViewMcpRequest(
  request: JsonRpcRequest,
  handlers: CadViewMcpHandlers,
): Promise<JsonRpcResponse | null> {
  const id = request.id;
  const method = typeof request.method === "string" ? request.method : "";

  if (!("id" in request)) {
    return null;
  }

  switch (method) {
    case "initialize":
      return jsonRpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: CAD_VIEW_MCP_SERVER_NAME, version: "0.1.0" },
      });
    case "notifications/initialized":
      return null;
    case "tools/list":
      return jsonRpcResult(id, {
        tools: [
          {
            name: CAD_VIEW_MCP_TOOL_NAME,
            description: SET_CAD_VIEW_TOOL_DESCRIPTION,
            inputSchema: {
              type: "object",
              properties: {
                view: {
                  type: "string",
                  enum: CAD_VIEW_VALUES,
                  description: "Named camera preset for the CAD panel.",
                },
                fit: {
                  type: "boolean",
                  description: "Fit the model to the viewport after changing orientation.",
                  default: true,
                },
              },
              required: ["view"],
              additionalProperties: false,
            },
          },
          {
            name: CAD_VIEW_MCP_EXPORT_TOOL_NAME,
            description: EXPORT_CAD_SCREENSHOT_TOOL_DESCRIPTION,
            inputSchema: {
              type: "object",
              properties: {
                view: {
                  type: "string",
                  enum: CAD_VIEW_VALUES,
                  description:
                    "Optional: apply this named view before capturing. Omit to use the current interactive camera.",
                },
                fit: {
                  type: "boolean",
                  description:
                    "When `view` is set, whether to fit the model after moving the camera.",
                  default: true,
                },
                suggestedBaseName: {
                  type: "string",
                  description:
                    "Optional filename stem (sanitized); a timestamp is always prefixed to avoid collisions.",
                },
              },
              additionalProperties: false,
            },
          },
        ],
      });
    case "tools/call": {
      const params = request.params && typeof request.params === "object" ? request.params : {};
      const name = "name" in params ? (params as { readonly name?: unknown }).name : undefined;
      const args =
        "arguments" in params ? (params as { readonly arguments?: unknown }).arguments : undefined;
      if (name === CAD_VIEW_MCP_TOOL_NAME) {
        const input = normalizeSetViewArguments(args);
        if (!input) {
          return jsonRpcError(id, -32602, "Invalid CAD view arguments.");
        }
        try {
          await handlers.setView(input);
          return jsonRpcResult(id, {
            content: [{ type: "text", text: `CAD view set to ${input.view}.` }],
          });
        } catch (error) {
          return jsonRpcError(id, -32603, error instanceof Error ? error.message : String(error));
        }
      }
      if (name === CAD_VIEW_MCP_EXPORT_TOOL_NAME) {
        const input = normalizeExportScreenshotArguments(args);
        if (!input) {
          return jsonRpcError(
            id,
            -32602,
            `Invalid export_cad_screenshot arguments, or ${CAD_VIEW_EXPORT_ROOT_ENV} is not configured.`,
          );
        }
        try {
          const result = await handlers.captureScreenshot(input);
          return jsonRpcResult(id, {
            content: [
              {
                type: "text",
                text: `Saved CAD screenshot to ${result.absolutePath} (under export root: ${result.relativePath}).`,
              },
            ],
          });
        } catch (error) {
          return jsonRpcError(id, -32603, error instanceof Error ? error.message : String(error));
        }
      }
      return jsonRpcError(id, -32602, "Unknown tool.");
    }
    default:
      return jsonRpcError(id, -32601, "Method not found.");
  }
}

async function postCadViewCommand(input: CadSetViewInput): Promise<void> {
  const origin = process.env.CADSENSE_CAD_VIEW_ORIGIN;
  const token = process.env.CADSENSE_CAD_VIEW_TOKEN;
  if (!origin || !token) {
    throw new Error("Missing CADSENSE_CAD_VIEW_ORIGIN or CADSENSE_CAD_VIEW_TOKEN.");
  }
  const response = await fetch(new URL("/api/cad/view-command", origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [CAD_VIEW_MCP_TOKEN_HEADER]: token,
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Failed to set CAD view: HTTP ${response.status}`);
  }
}

async function postCadScreenshotCapture(
  input: CadScreenshotMcpCaptureInput,
): Promise<CadScreenshotCaptureHttpResult> {
  const origin = process.env.CADSENSE_CAD_VIEW_ORIGIN;
  const token = process.env.CADSENSE_CAD_VIEW_TOKEN;
  if (!origin || !token) {
    throw new Error("Missing CADSENSE_CAD_VIEW_ORIGIN or CADSENSE_CAD_VIEW_TOKEN.");
  }
  const response = await fetch(new URL("/api/cad/screenshot-capture", origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [CAD_VIEW_MCP_TOKEN_HEADER]: token,
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Failed to capture CAD screenshot: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
    );
  }
  return (await response.json()) as CadScreenshotCaptureHttpResult;
}

export async function runCadViewMcpServer(): Promise<void> {
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  for await (const line of input) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      process.stdout.write(`${JSON.stringify(jsonRpcError(null, -32700, "Parse error."))}\n`);
      continue;
    }

    try {
      const response = await handleCadViewMcpRequest(request, {
        setView: postCadViewCommand,
        captureScreenshot: postCadScreenshotCapture,
      });
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "CAD view command failed.";
      process.stdout.write(
        `${JSON.stringify(jsonRpcError(request.id ?? null, -32000, message))}\n`,
      );
    }
  }
}
