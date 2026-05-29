// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  fetchMechbaseArtifact,
  MECHBASE_API_KEY_ENV,
  MECHBASE_PUBLIC_API_BASE_URL,
  searchMechbase,
  type MechbaseFetch,
} from "./MechbaseApi.ts";

export const MECHBASE_MCP_SERVER_NAME = "cadsense-mechbase";
export const MECHBASE_MCP_SEARCH_TOOL_NAME = "search_mechbase";
export const MECHBASE_MCP_FETCH_ARTIFACT_TOOL_NAME = "fetch_mechbase_artifact";

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
}

type JsonRpcResponse =
  | {
      readonly jsonrpc: "2.0";
      readonly id: string | number | null;
      readonly result: unknown;
    }
  | {
      readonly jsonrpc: "2.0";
      readonly id: string | number | null;
      readonly error: { readonly code: number; readonly message: string };
    };

function resolveCadSenseMainScriptForMcpChild(): string {
  const fromArgv = process.argv[1];
  if (typeof fromArgv === "string" && fromArgv.length > 0 && !fromArgv.startsWith("-")) {
    return fromArgv;
  }
  return fileURLToPath(import.meta.url);
}

function jsonRpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolText(text: string) {
  return { content: [{ type: "text", text }] };
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/avif":
      return ".avif";
    case "image/gif":
      return ".gif";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/svg+xml":
      return ".svg";
    case "image/webp":
      return ".webp";
    default:
      return ".img";
  }
}

function localArtifactBaseName(artifactUrl: string, mimeType: string): string {
  const parsed = new URL(artifactUrl);
  const leaf = path.basename(parsed.pathname).replace(/\.[^.]+$/, "");
  const safeLeaf = leaf.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(artifactUrl).digest("hex").slice(0, 16);
  const name = safeLeaf.length > 0 ? safeLeaf.slice(0, 48) : "mechbase-artifact";
  return `${name}-${hash}${extensionForMimeType(mimeType)}`;
}

async function saveLocalArtifactForInspection(input: {
  readonly artifactUrl: string;
  readonly mimeType: string;
  readonly data: Uint8Array;
  readonly artifactDirectory?: string;
}): Promise<string> {
  const directory = input.artifactDirectory ?? path.join(tmpdir(), "cadsense-mechbase-artifacts");
  await mkdir(directory, { recursive: true });
  const localPath = path.join(directory, localArtifactBaseName(input.artifactUrl, input.mimeType));
  await writeFile(localPath, input.data);
  return localPath;
}

function artifactToolResult(input: {
  readonly artifactUrl: string;
  readonly mimeType: string;
  readonly data: Uint8Array;
  readonly sizeBytes: number;
  readonly localPath: string;
}) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            artifactUrl: input.artifactUrl,
            localPath: input.localPath,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            guidance:
              "This image was saved locally for inspection and is also attached as image content. Inspect the visible image before embedding it in CadSense chat. Use it only if it visibly matches the requested mechanism or precedent; discard logos, covers, blank pages, or unrelated crops and fetch another candidate. If it matches, show it with Markdown image syntax and cite the source as plain text like 'Source: FRC 254 in 2020, page 22', not as a Mechbase URL hyperlink.",
          },
          null,
          2,
        ),
      },
      {
        type: "image",
        data: Buffer.from(input.data).toString("base64"),
        mimeType: input.mimeType,
      },
    ],
  };
}

function getToolCall(
  request: JsonRpcRequest,
): { readonly name: string; readonly arguments: unknown } | null {
  const params = request.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  return typeof record.name === "string"
    ? { name: record.name, arguments: record.arguments }
    : null;
}

export function makeMechbaseMcpStdioServer(apiKey: string): {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
} {
  const electronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  return {
    name: MECHBASE_MCP_SERVER_NAME,
    command: process.execPath,
    args: [resolveCadSenseMainScriptForMcpChild(), "mcp", "mechbase"],
    env: [
      { name: MECHBASE_API_KEY_ENV, value: apiKey },
      ...(electronRunAsNode ? [{ name: "ELECTRON_RUN_AS_NODE", value: electronRunAsNode }] : []),
    ],
  };
}

export function makeMechbaseCodexMcpConfig(apiKey: string): Record<string, unknown> {
  const server = makeMechbaseMcpStdioServer(apiKey);
  return {
    mcp_servers: {
      [MECHBASE_MCP_SERVER_NAME]: {
        command: server.command,
        args: server.args,
        env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
      },
    },
  };
}

export function makeMechbaseClaudeMcpServers(apiKey: string): Record<
  string,
  {
    readonly command: string;
    readonly args: string[];
    readonly env: Record<string, string>;
  }
> {
  const server = makeMechbaseMcpStdioServer(apiKey);
  return {
    [MECHBASE_MCP_SERVER_NAME]: {
      command: server.command,
      args: [...server.args],
      env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
    },
  };
}

export async function handleMechbaseMcpRequest(
  request: JsonRpcRequest,
  options?: {
    readonly apiKey?: string;
    readonly fetch?: MechbaseFetch;
    readonly artifactDirectory?: string;
  },
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;
  if (request.method === "notifications/initialized") {
    return null;
  }
  if (request.method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: MECHBASE_MCP_SERVER_NAME, version: "0.1.0" },
    });
  }
  if (request.method === "tools/list") {
    return jsonRpcResult(id, {
      tools: [
        {
          name: MECHBASE_MCP_SEARCH_TOOL_NAME,
          description: [
            "Search indexed FRC mechanism binders in Mechbase.",
            "Use this when the user asks for examples, references, page context, or design precedent from FRC mechanisms.",
            `Relative image and context URLs are returned as absolute URLs under ${MECHBASE_PUBLIC_API_BASE_URL}.`,
            `Use ${MECHBASE_MCP_FETCH_ARTIFACT_TOOL_NAME} only when one returned image URL looks likely to clarify the answer or review.`,
            "Before answering with a Mechbase image, fetch the candidate image with fetch_mechbase_artifact and inspect the returned image content. Do not show logos, covers, blank pages, or unrelated crops.",
            "When answering in CadSense chat, display the inspected matching image artifact with Markdown image syntax like ![short description](artifact_url). Do not use separate Mechbase source hyperlinks. Binder names use <TEAM>-<YEAR>.pdf; cite source as plain text like 'Source: FRC 254 in 2020, page 22'.",
          ].join("\n"),
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Required search text." },
              top_k: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                description: "Optional number of results to return.",
              },
              team: { type: "string", description: "Optional team filter, such as 254." },
              year: { type: "integer", description: "Optional year filter, such as 2024." },
              source: {
                type: "string",
                description: "Optional PDF filename filter, such as 254-2024.pdf.",
              },
              modality: {
                type: "string",
                enum: ["text", "page_image", "extracted_image"],
                description: "Optional result modality filter.",
              },
              debug: { type: "boolean", description: "Include extra scoring details." },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
        {
          name: MECHBASE_MCP_FETCH_ARTIFACT_TOOL_NAME,
          description: [
            "Fetch one Mechbase image artifact returned by search_mechbase so the agent can inspect it visually.",
            "The fetched preview is saved to a local file and returned as image content.",
            "Use this selectively after search_mechbase returns a promising artifact_url or linked_artifact_urls entry.",
            "Only use and cite the fetched image if the inspected image visibly matches the mechanism or precedent being discussed. Discard logos, covers, blank pages, and unrelated crops.",
            "In CadSense chat, show the matching artifact with Markdown image syntax and cite the source as plain text like 'Source: FRC 254 in 2020, page 22', not as a Mechbase URL hyperlink.",
          ].join("\n"),
          inputSchema: {
            type: "object",
            properties: {
              artifactUrl: {
                type: "string",
                description:
                  "Required Mechbase artifact URL, usually artifact_url or linked_artifact_urls from search_mechbase.",
              },
            },
            required: ["artifactUrl"],
            additionalProperties: false,
          },
        },
      ],
    });
  }
  if (request.method === "tools/call") {
    const call = getToolCall(request);
    if (!call) return jsonRpcError(id, -32602, "Invalid tools/call parameters.");
    if (
      call.name !== MECHBASE_MCP_SEARCH_TOOL_NAME &&
      call.name !== MECHBASE_MCP_FETCH_ARTIFACT_TOOL_NAME
    ) {
      return jsonRpcError(id, -32601, `Unknown tool: ${call.name}`);
    }
    const apiKey = options?.apiKey ?? process.env[MECHBASE_API_KEY_ENV];
    if (!apiKey?.trim()) {
      return jsonRpcError(id, -32000, `Missing ${MECHBASE_API_KEY_ENV}.`);
    }
    if (call.name === MECHBASE_MCP_SEARCH_TOOL_NAME) {
      const result = await searchMechbase(call.arguments ?? {}, apiKey, options?.fetch);
      return jsonRpcResult(id, toolText(JSON.stringify(result, null, 2)));
    }
    const result = await fetchMechbaseArtifact(call.arguments ?? {}, apiKey, options?.fetch);
    const localPath = await saveLocalArtifactForInspection({
      artifactUrl: result.artifactUrl,
      mimeType: result.mimeType,
      data: result.data,
      ...(options?.artifactDirectory !== undefined
        ? { artifactDirectory: options.artifactDirectory }
        : {}),
    });
    return jsonRpcResult(id, artifactToolResult({ ...result, localPath }));
  }
  return jsonRpcError(id, -32601, `Unknown method: ${request.method ?? ""}`);
}

export async function runMechbaseMcpServer(): Promise<void> {
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
      const response = await handleMechbaseMcpRequest(request);
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Mechbase MCP request failed.";
      process.stdout.write(
        `${JSON.stringify(jsonRpcError(request.id ?? null, -32000, message))}\n`,
      );
    }
  }
}
