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

function artifactToolResult(input: {
  readonly artifactUrl: string;
  readonly mimeType: string;
  readonly data: Uint8Array;
  readonly sizeBytes: number;
}) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            artifactUrl: input.artifactUrl,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            guidance:
              "Use this image only if it visibly matches the mechanism or precedent being discussed. Cite the source URL when using it in a review.",
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
  options?: { readonly apiKey?: string; readonly fetch?: MechbaseFetch },
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
            "Use this selectively after search_mechbase returns a promising artifact_url or linked_artifact_urls entry.",
            "Only use and cite the fetched image if it visibly matches the mechanism or precedent being discussed.",
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
    return jsonRpcResult(id, artifactToolResult(result));
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
