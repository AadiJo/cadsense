import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import * as readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  CadScreenshotMcpCaptureInput,
  CadControlInput,
  CadHierarchyRequestInput,
  type CadHierarchyResult,
  CadSetCameraInput,
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
export const CAD_VIEW_MCP_CAMERA_TOOL_NAME = "set_cad_camera";
export const CAD_VIEW_MCP_EXPORT_TOOL_NAME = "export_cad_screenshot";
export const CAD_VIEW_MCP_HIERARCHY_TOOL_NAME = "get_cad_hierarchy";
export const CAD_VIEW_MCP_COMPONENT_VISIBILITY_TOOL_NAME = "set_cad_component_visibility";
export const CAD_VIEW_MCP_EXPLODED_TOOL_NAME = "set_cad_exploded";
export const CAD_VIEW_MCP_ZOOM_TOOL_NAME = "zoom_cad_to_fit";
export const CAD_VIEW_MCP_CALCULATOR_TOOL_NAME = "frc_mechanical_calculator";
export const CAD_VIEW_MCP_TOKEN_HEADER = "x-cadsense-cad-view-token";
export const CAD_VIEW_MCP_TOKEN = randomUUID();
export const CAD_VIEW_MCP_HTTP_PATH = "/api/mcp/cad";
export const CAD_VIEW_MCP_PROTOCOL_VERSION = "2026-07-28";
export const CAD_VIEW_EXPORT_ROOT_ENV = "CADSENSE_CAD_VIEW_EXPORT_ROOT";
export const CAD_HIERARCHY_HTTP_TIMEOUT_MS = 15_000;
export const CAD_SCREENSHOT_HTTP_TIMEOUT_MS = 135_000;
export const CAD_VIEW_MCP_TIMEOUT_MS = CAD_SCREENSHOT_HTTP_TIMEOUT_MS + 15_000;

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
const isCadSetCameraInput = Schema.is(CadSetCameraInput);
const isCadControlInput = Schema.is(CadControlInput);
const isCadHierarchyRequestInput = Schema.is(CadHierarchyRequestInput);
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

const SET_CAD_CAMERA_TOOL_DESCRIPTION = [
  "Set the CAD side panel camera to a freeform view direction. Use this when a non-standard oblique angle is useful, for example slightly above-front-right instead of exactly front/right/top.",
  "The `direction` vector is the camera position direction from the model center; it does not need to be normalized. `up` controls screen-up and usually should be [0, 0, 1] for CAD views with Z vertical.",
  "Use `fit: true` for normal inspection. Use `closeUp: true` for a detail view at the same angle.",
  "",
  "Known standard view vectors:",
  CAD_VIEW_ORIENTATION_GUIDE,
  "Equivalent raw vectors: top [0,0,1] up [0,1,0]; bottom [0,0,-1] up [0,1,0]; front [0,-1,0] up [0,0,1]; back [0,1,0] up [0,0,1]; left [-1,0,0] up [0,0,1]; right [1,0,0] up [0,0,1]; isometric [1,-1,1] up [0,0,1].",
  "For in-between views, blend those directions. Examples: slightly above front-right [0.7,-1,0.35]; high front-left [-0.8,-1,0.8]; shallow rear-right [1,0.8,0.25].",
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

const FRC_MECHANICAL_CALCULATOR_TOOL_DESCRIPTION = [
  "Run lightweight FRC mechanical design calculations from measured CAD or user-provided inputs.",
  "Use this only after identifying the exact inputs needed; do not invent dimensions. Results are first-pass estimates for review triage, not design signoff.",
  "Supported calculation types:",
  "- roller_surface_speed: inputs rpm, diameterIn; returns surface speed in ft/s.",
  "- gear_reduction: inputs drivingTeeth, drivenTeeth, optional inputRpm; returns reduction and output rpm.",
  "- shaft_deflection_center_load: inputs spanIn, loadLbf, diameterIn, optional modulusPsi; assumes a simply supported round shaft with center point load.",
  "- compression: inputs gamePieceDiameterIn, gapIn; returns compression in inches and percent of game-piece diameter.",
].join("\n");

function resolveCadSenseMainScriptForMcpChild(): string {
  const fromArgv = process.argv[1];
  if (typeof fromArgv === "string" && fromArgv.length > 0 && !fromArgv.startsWith("-")) {
    return fromArgv;
  }
  return fileURLToPath(import.meta.url);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function calculateFrcMechanical(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const calculationType = record.calculationType;
  if (calculationType === "roller_surface_speed") {
    const rpm = finiteNumber(record.rpm);
    const diameterIn = positiveNumber(record.diameterIn);
    if (rpm === undefined || diameterIn === undefined) return undefined;
    const feetPerSecond = (Math.PI * diameterIn * rpm) / 12 / 60;
    return {
      calculationType,
      inputs: { rpm, diameterIn },
      result: { feetPerSecond, inchesPerSecond: feetPerSecond * 12 },
      notes: ["Surface speed assumes no slip and uses the roller outside diameter."],
    };
  }
  if (calculationType === "gear_reduction") {
    const drivingTeeth = positiveNumber(record.drivingTeeth);
    const drivenTeeth = positiveNumber(record.drivenTeeth);
    const inputRpm = finiteNumber(record.inputRpm);
    if (drivingTeeth === undefined || drivenTeeth === undefined) return undefined;
    const reduction = drivenTeeth / drivingTeeth;
    return {
      calculationType,
      inputs: { drivingTeeth, drivenTeeth, ...(inputRpm !== undefined ? { inputRpm } : {}) },
      result: {
        reduction,
        ratioLabel: `${drivenTeeth}:${drivingTeeth}`,
        ...(inputRpm !== undefined ? { outputRpm: inputRpm / reduction } : {}),
      },
      notes: ["Reduction is driven teeth divided by driving teeth."],
    };
  }
  if (calculationType === "shaft_deflection_center_load") {
    const spanIn = positiveNumber(record.spanIn);
    const loadLbf = positiveNumber(record.loadLbf);
    const diameterIn = positiveNumber(record.diameterIn);
    const modulusPsi = positiveNumber(record.modulusPsi) ?? 29_000_000;
    if (spanIn === undefined || loadLbf === undefined || diameterIn === undefined) {
      return undefined;
    }
    const momentOfInertiaIn4 = (Math.PI * diameterIn ** 4) / 64;
    const deflectionIn = (loadLbf * spanIn ** 3) / (48 * modulusPsi * momentOfInertiaIn4);
    return {
      calculationType,
      inputs: { spanIn, loadLbf, diameterIn, modulusPsi },
      result: { momentOfInertiaIn4, deflectionIn },
      notes: [
        "First-pass estimate for a simply supported round shaft with a center point load.",
        "Real roller assemblies may differ because of tube construction, load distribution, bearings, and end constraints.",
      ],
    };
  }
  if (calculationType === "compression") {
    const gamePieceDiameterIn = positiveNumber(record.gamePieceDiameterIn);
    const gapIn = finiteNumber(record.gapIn);
    if (gamePieceDiameterIn === undefined || gapIn === undefined) return undefined;
    const compressionIn = gamePieceDiameterIn - gapIn;
    return {
      calculationType,
      inputs: { gamePieceDiameterIn, gapIn },
      result: {
        compressionIn,
        compressionPercent: (compressionIn / gamePieceDiameterIn) * 100,
      },
      notes: ["Positive compression means the gap is smaller than the game-piece diameter."],
    };
  }
  return undefined;
}

export function makeCadViewMcpOrigin(config: Pick<ServerConfigShape, "host" | "port">): string {
  const hostname =
    config.host && !isWildcardHost(config.host) ? formatHostForUrl(config.host) : "127.0.0.1";
  return `http://${hostname}:${config.port}`;
}

export interface CadViewMcpRequestContext {
  readonly threadId?: string;
  readonly exportRoot?: string;
  readonly protocolVersion?: string;
}

function signCadViewMcpCapability(payload: string): string {
  return createHmac("sha256", CAD_VIEW_MCP_TOKEN).update(payload).digest("base64url");
}

export function makeCadViewMcpCapability(threadId?: string, exportRoot?: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      ...(threadId ? { threadId } : {}),
      ...(exportRoot?.trim() ? { exportRoot: exportRoot.trim() } : {}),
    }),
  ).toString("base64url");
  return `${payload}.${signCadViewMcpCapability(payload)}`;
}

export function parseCadViewMcpCapability(
  capability: string | undefined,
): CadViewMcpRequestContext | undefined {
  if (!capability) return undefined;
  const separator = capability.lastIndexOf(".");
  if (separator <= 0) return undefined;
  const payload = capability.slice(0, separator);
  const expected = Buffer.from(signCadViewMcpCapability(payload));
  const actual = Buffer.from(capability.slice(separator + 1));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
    const record = decoded as Record<string, unknown>;
    const threadId =
      record.threadId === undefined ? undefined : decodeThreadIdUnknownSync(record.threadId);
    const exportRoot =
      typeof record.exportRoot === "string" && record.exportRoot.trim()
        ? record.exportRoot.trim()
        : undefined;
    return { ...(threadId ? { threadId } : {}), ...(exportRoot ? { exportRoot } : {}) };
  } catch {
    return undefined;
  }
}

export function makeCadViewMcpHttpServer(
  config: Pick<ServerConfigShape, "host" | "port">,
  threadId?: string,
  exportRoot?: string,
): {
  readonly name: string;
  readonly url: string;
  readonly headers: Record<string, string>;
} {
  return {
    name: CAD_VIEW_MCP_SERVER_NAME,
    url: new URL(CAD_VIEW_MCP_HTTP_PATH, makeCadViewMcpOrigin(config)).toString(),
    headers: { [CAD_VIEW_MCP_TOKEN_HEADER]: makeCadViewMcpCapability(threadId, exportRoot) },
  };
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
  const server = makeCadViewMcpHttpServer(config, threadId, exportRoot);
  return {
    mcp_servers: {
      [CAD_VIEW_MCP_SERVER_NAME]: {
        url: server.url,
        http_headers: server.headers,
      },
    },
  };
}

export function makeCadViewOpenCodeMcpServerConfig(
  config: Pick<ServerConfigShape, "host" | "port">,
  threadId?: string,
  exportRoot?: string,
): {
  readonly name: string;
  readonly config: {
    readonly type: "remote";
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly enabled: true;
    readonly timeout: number;
  };
} {
  const server = makeCadViewMcpHttpServer(config, threadId, exportRoot);
  return {
    name: server.name,
    config: {
      type: "remote",
      url: server.url,
      headers: server.headers,
      enabled: true,
      timeout: CAD_VIEW_MCP_TIMEOUT_MS,
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
    readonly type: "http";
    readonly url: string;
    readonly headers: Record<string, string>;
  }
> {
  const server = makeCadViewMcpHttpServer(config, threadId, exportRoot);
  return {
    [CAD_VIEW_MCP_SERVER_NAME]: {
      type: "http",
      url: server.url,
      headers: server.headers,
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

function normalizeSetCameraArguments(args: unknown): CadSetCameraInput | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const candidate = args as Record<string, unknown>;
  const input = {
    threadId: candidate.threadId ?? process.env.CADSENSE_CAD_VIEW_THREAD_ID,
    direction: candidate.direction,
    up: candidate.up,
    ...("distance" in candidate ? { distance: candidate.distance } : {}),
    fit: candidate.fit,
    closeUp: candidate.closeUp,
  };
  if (!isCadSetCameraInput(input)) {
    return undefined;
  }
  if (!input.direction.every(Number.isFinite) || input.direction.every((value) => value === 0)) {
    return undefined;
  }
  if (input.up && (!input.up.every(Number.isFinite) || input.up.every((value) => value === 0))) {
    return undefined;
  }
  if (input.distance !== undefined && (!Number.isFinite(input.distance) || input.distance <= 0)) {
    return undefined;
  }
  return {
    threadId: input.threadId,
    direction: input.direction,
    ...(input.up === undefined ? {} : { up: input.up }),
    ...(input.distance === undefined ? {} : { distance: input.distance }),
    fit: input.fit,
    closeUp: input.closeUp,
  };
}

function normalizeThreadIdArg(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return process.env.CADSENSE_CAD_VIEW_THREAD_ID;
  }
  const candidate = args as Record<string, unknown>;
  const threadId = candidate.threadId ?? process.env.CADSENSE_CAD_VIEW_THREAD_ID;
  return typeof threadId === "string" ? threadId : undefined;
}

function normalizeControlArguments(
  args: unknown,
  type: CadControlInput["type"],
): CadControlInput | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const candidate = args as Record<string, unknown>;
  const threadId = candidate.threadId ?? process.env.CADSENSE_CAD_VIEW_THREAD_ID;
  const input =
    type === "set-component-visibility"
      ? { type, threadId, componentId: candidate.componentId, visible: candidate.visible }
      : type === "set-exploded"
        ? { type, threadId, exploded: candidate.exploded }
        : { type, threadId };
  return isCadControlInput(input) ? input : undefined;
}

function normalizeHierarchyArguments(args: unknown): CadHierarchyRequestInput | undefined {
  const threadId = normalizeThreadIdArg(args);
  const input = { threadId };
  return isCadHierarchyRequestInput(input) ? input : undefined;
}

function normalizeExportScreenshotArguments(
  args: unknown,
): CadScreenshotMcpCaptureInput | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const candidate = args as Record<string, unknown>;
  const exportRoot =
    (typeof candidate.exportRoot === "string" ? candidate.exportRoot.trim() : undefined) ??
    process.env[CAD_VIEW_EXPORT_ROOT_ENV]?.trim();
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
  readonly sendControl: (input: CadControlInput) => Promise<void>;
  readonly getHierarchy: (input: CadHierarchyRequestInput) => Promise<CadHierarchyResult>;
  readonly captureScreenshot: (
    input: CadScreenshotMcpCaptureInput,
  ) => Promise<CadScreenshotCaptureHttpResult>;
}

async function delay(ms: number): Promise<void> {
  await sleep(ms);
}

type CadHierarchyComponent = CadHierarchyResult["components"][number];

function buildCadHierarchyChildren(
  components: ReadonlyArray<CadHierarchyComponent>,
): Map<string | undefined, CadHierarchyComponent[]> {
  const childrenByParentId = new Map<string | undefined, CadHierarchyComponent[]>();
  for (const component of components) {
    const children = childrenByParentId.get(component.parentId);
    if (children) {
      children.push(component);
    } else {
      childrenByParentId.set(component.parentId, [component]);
    }
  }
  return childrenByParentId;
}

function cadHierarchyComponentEffectivelyVisible(
  component: CadHierarchyComponent,
  childrenByParentId: ReadonlyMap<string | undefined, ReadonlyArray<CadHierarchyComponent>>,
  visited = new Set<string>(),
): boolean {
  if (visited.has(component.id)) {
    return false;
  }
  if (!component.visible) {
    return false;
  }
  visited.add(component.id);
  const children = childrenByParentId.get(component.id) ?? [];
  if (children.length === 0) {
    return true;
  }
  return children.some((child) =>
    cadHierarchyComponentEffectivelyVisible(child, childrenByParentId, new Set(visited)),
  );
}

async function verifyCadComponentVisibility(
  handlers: Pick<CadViewMcpHandlers, "getHierarchy">,
  input: Extract<CadControlInput, { readonly type: "set-component-visibility" }>,
): Promise<{
  readonly componentName: string;
  readonly componentsChecked: number;
  readonly confirmedBy: "component" | "subtree";
}> {
  let lastStatus: CadHierarchyResult["status"] | undefined;
  let lastMessage: string | undefined;
  let lastVisible: boolean | undefined;
  let lastEffectiveVisible: boolean | undefined;
  let componentSeen = false;
  let componentName = input.componentId;

  for (const waitMs of [150, 300, 600, 900]) {
    await delay(waitMs);
    const hierarchy = await handlers.getHierarchy({ threadId: input.threadId });
    lastStatus = hierarchy.status ?? "loaded";
    lastMessage = hierarchy.message;
    if (lastStatus !== "loaded") {
      continue;
    }
    const component = hierarchy.components.find((item) => item.id === input.componentId);
    if (!component) {
      continue;
    }
    componentSeen = true;
    componentName = component.name;
    lastVisible = component.visible;
    if (component.visible === input.visible) {
      return {
        componentName,
        componentsChecked: hierarchy.components.length,
        confirmedBy: "component",
      };
    }
    const childrenByParentId = buildCadHierarchyChildren(hierarchy.components);
    const effectiveVisible = cadHierarchyComponentEffectivelyVisible(component, childrenByParentId);
    lastEffectiveVisible = effectiveVisible;
    if (!input.visible && component.hasChildren && !effectiveVisible) {
      return {
        componentName,
        componentsChecked: hierarchy.components.length,
        confirmedBy: "subtree",
      };
    }
  }

  if (!componentSeen) {
    const detail =
      lastStatus && lastStatus !== "loaded"
        ? ` Last hierarchy status was '${lastStatus}'${lastMessage ? `: ${lastMessage}` : "."}`
        : "";
    throw new Error(
      `CAD component '${input.componentId}' was not found after the command.${detail}`,
    );
  }

  throw new Error(
    `CAD component '${componentName}' (${input.componentId}) still reported visible=${String(
      lastVisible,
    )} with effective subtree visible=${String(lastEffectiveVisible)} after setting visible=${String(
      input.visible,
    )}.`,
  );
}

async function handleCadViewMcpRequestLegacy(
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
            name: CAD_VIEW_MCP_CAMERA_TOOL_NAME,
            description: SET_CAD_CAMERA_TOOL_DESCRIPTION,
            inputSchema: {
              type: "object",
              properties: {
                direction: {
                  type: "array",
                  items: { type: "number" },
                  minItems: 3,
                  maxItems: 3,
                  description:
                    "Camera direction from the model center as [x, y, z]. Must not be [0,0,0].",
                },
                up: {
                  type: "array",
                  items: { type: "number" },
                  minItems: 3,
                  maxItems: 3,
                  description: "Optional screen-up vector. Usually [0,0,1] for CAD views.",
                },
                fit: {
                  type: "boolean",
                  description: "Fit the model to the viewport after changing camera direction.",
                  default: true,
                },
                distance: {
                  type: "number",
                  description:
                    "Optional camera distance from the model center. Usually omitted so the viewer chooses a fitted inspection distance.",
                },
                closeUp: {
                  type: "boolean",
                  description: "Move closer along the same view direction for detail inspection.",
                  default: false,
                },
              },
              required: ["direction"],
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
          {
            name: CAD_VIEW_MCP_HIERARCHY_TOOL_NAME,
            description:
              "Return the current CAD assembly/component hierarchy, including stable component ids and visibility states. The result includes a status field; if status is loading, unavailable, or error, do not treat an empty components array as evidence that the CAD has no hierarchy.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
          {
            name: CAD_VIEW_MCP_COMPONENT_VISIBILITY_TOOL_NAME,
            description:
              "Toggle a CAD hierarchy component on or off by component id from get_cad_hierarchy.",
            inputSchema: {
              type: "object",
              properties: {
                componentId: { type: "string" },
                visible: { type: "boolean" },
              },
              required: ["componentId", "visible"],
              additionalProperties: false,
            },
          },
          {
            name: CAD_VIEW_MCP_EXPLODED_TOOL_NAME,
            description: "Enable or disable the CAD exploded view.",
            inputSchema: {
              type: "object",
              properties: { exploded: { type: "boolean" } },
              required: ["exploded"],
              additionalProperties: false,
            },
          },
          {
            name: CAD_VIEW_MCP_ZOOM_TOOL_NAME,
            description: "Zoom the CAD viewer to fit the current visible model.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
          {
            name: CAD_VIEW_MCP_CALCULATOR_TOOL_NAME,
            description: FRC_MECHANICAL_CALCULATOR_TOOL_DESCRIPTION,
            inputSchema: {
              type: "object",
              properties: {
                calculationType: {
                  type: "string",
                  enum: [
                    "roller_surface_speed",
                    "gear_reduction",
                    "shaft_deflection_center_load",
                    "compression",
                  ],
                },
                rpm: { type: "number" },
                diameterIn: { type: "number" },
                drivingTeeth: { type: "number" },
                drivenTeeth: { type: "number" },
                inputRpm: { type: "number" },
                spanIn: { type: "number" },
                loadLbf: { type: "number" },
                modulusPsi: { type: "number" },
                gamePieceDiameterIn: { type: "number" },
                gapIn: { type: "number" },
              },
              required: ["calculationType"],
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
      if (name === CAD_VIEW_MCP_CAMERA_TOOL_NAME) {
        const input = normalizeSetCameraArguments(args);
        if (!input) {
          return jsonRpcError(id, -32602, "Invalid CAD camera arguments.");
        }
        try {
          await handlers.sendControl({ type: "set-camera", ...input });
          return jsonRpcResult(id, {
            content: [
              {
                type: "text",
                text: `CAD camera set to direction [${input.direction.join(", ")}].`,
              },
            ],
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
      if (name === CAD_VIEW_MCP_HIERARCHY_TOOL_NAME) {
        const input = normalizeHierarchyArguments(args);
        if (!input) return jsonRpcError(id, -32602, "Invalid CAD hierarchy arguments.");
        try {
          const result = await handlers.getHierarchy(input);
          return jsonRpcResult(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: result.status ?? "loaded",
                    ...(result.message ? { message: result.message } : {}),
                    components: result.components,
                  },
                  null,
                  2,
                ),
              },
            ],
          });
        } catch (error) {
          return jsonRpcError(id, -32603, error instanceof Error ? error.message : String(error));
        }
      }
      if (
        name === CAD_VIEW_MCP_COMPONENT_VISIBILITY_TOOL_NAME ||
        name === CAD_VIEW_MCP_EXPLODED_TOOL_NAME ||
        name === CAD_VIEW_MCP_ZOOM_TOOL_NAME
      ) {
        const type =
          name === CAD_VIEW_MCP_COMPONENT_VISIBILITY_TOOL_NAME
            ? "set-component-visibility"
            : name === CAD_VIEW_MCP_EXPLODED_TOOL_NAME
              ? "set-exploded"
              : "zoom-to-fit";
        const input = normalizeControlArguments(args ?? {}, type);
        if (!input) return jsonRpcError(id, -32602, "Invalid CAD control arguments.");
        try {
          await handlers.sendControl(input);
          if (input.type === "set-component-visibility") {
            const verification = await verifyCadComponentVisibility(handlers, input);
            const visibilityScope =
              verification.confirmedBy === "subtree"
                ? "CAD component subtree visibility confirmed"
                : "CAD component visibility confirmed";
            return jsonRpcResult(id, {
              content: [
                {
                  type: "text",
                  text: `${visibilityScope} for ${verification.componentName} (${input.componentId}); visible=${String(
                    input.visible,
                  )}.`,
                },
              ],
            });
          }
          return jsonRpcResult(id, {
            content: [{ type: "text", text: "CAD control command sent." }],
          });
        } catch (error) {
          return jsonRpcError(id, -32603, error instanceof Error ? error.message : String(error));
        }
      }
      if (name === CAD_VIEW_MCP_CALCULATOR_TOOL_NAME) {
        const result = calculateFrcMechanical(args);
        if (!result) {
          return jsonRpcError(id, -32602, "Invalid FRC mechanical calculator arguments.");
        }
        return jsonRpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      }
      return jsonRpcError(id, -32602, "Unknown tool.");
    }
    default:
      return jsonRpcError(id, -32601, "Method not found.");
  }
}

export async function handleCadViewMcpRequest(
  request: JsonRpcRequest,
  handlers: CadViewMcpHandlers,
  context: CadViewMcpRequestContext = {},
): Promise<JsonRpcResponse | null> {
  const method = typeof request.method === "string" ? request.method : "";
  if (method === "server/discover" && "id" in request) {
    return jsonRpcResult(request.id, {
      resultType: "complete",
      supportedVersions: [CAD_VIEW_MCP_PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo: { name: CAD_VIEW_MCP_SERVER_NAME, version: "0.1.0" },
    });
  }

  let contextualRequest = request;
  if (method === "tools/call" && (context.threadId || context.exportRoot)) {
    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : {};
    const args =
      params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
    contextualRequest = {
      ...request,
      params: {
        ...params,
        arguments: {
          ...args,
          ...(context.threadId ? { threadId: context.threadId } : {}),
          ...(context.exportRoot ? { exportRoot: context.exportRoot } : {}),
        },
      },
    };
  }

  const response = await handleCadViewMcpRequestLegacy(contextualRequest, handlers);
  if (
    context.protocolVersion !== CAD_VIEW_MCP_PROTOCOL_VERSION ||
    !response ||
    !("result" in response) ||
    !response.result ||
    typeof response.result !== "object"
  ) {
    return response;
  }
  return {
    ...response,
    result: {
      ...(response.result as Record<string, unknown>),
      ...(method === "tools/list" ? { ttlMs: 300_000, cacheScope: "private" } : {}),
      resultType: "complete",
    },
  };
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

async function postCadControlCommand(input: CadControlInput): Promise<void> {
  const origin = process.env.CADSENSE_CAD_VIEW_ORIGIN;
  const token = process.env.CADSENSE_CAD_VIEW_TOKEN;
  if (!origin || !token) {
    throw new Error("Missing CADSENSE_CAD_VIEW_ORIGIN or CADSENSE_CAD_VIEW_TOKEN.");
  }
  const response = await fetch(new URL("/api/cad/control-command", origin), {
    method: "POST",
    headers: { "content-type": "application/json", [CAD_VIEW_MCP_TOKEN_HEADER]: token },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Failed to control CAD view: HTTP ${response.status}`);
}

async function postCadHierarchyRequest(
  input: CadHierarchyRequestInput,
): Promise<CadHierarchyResult> {
  const origin = process.env.CADSENSE_CAD_VIEW_ORIGIN;
  const token = process.env.CADSENSE_CAD_VIEW_TOKEN;
  if (!origin || !token) {
    throw new Error("Missing CADSENSE_CAD_VIEW_ORIGIN or CADSENSE_CAD_VIEW_TOKEN.");
  }
  let response: Response;
  try {
    response = await fetch(new URL("/api/cad/hierarchy", origin), {
      method: "POST",
      headers: { "content-type": "application/json", [CAD_VIEW_MCP_TOKEN_HEADER]: token },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(CAD_HIERARCHY_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(
        `CAD hierarchy request timed out after ${Math.round(
          CAD_HIERARCHY_HTTP_TIMEOUT_MS / 1000,
        )} seconds before the server responded.`,
        { cause: error },
      );
    }
    throw error;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const suffix = detail ? ` - ${detail}` : "";
    throw new Error(`Failed to get CAD hierarchy: HTTP ${response.status}${suffix}`);
  }
  return (await response.json()) as CadHierarchyResult;
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return false;
  }
  const name = (error as { readonly name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

export async function postCadScreenshotCapture(
  input: CadScreenshotMcpCaptureInput,
): Promise<CadScreenshotCaptureHttpResult> {
  const origin = process.env.CADSENSE_CAD_VIEW_ORIGIN;
  const token = process.env.CADSENSE_CAD_VIEW_TOKEN;
  if (!origin || !token) {
    throw new Error("Missing CADSENSE_CAD_VIEW_ORIGIN or CADSENSE_CAD_VIEW_TOKEN.");
  }
  let response: Response;
  try {
    response = await fetch(new URL("/api/cad/screenshot-capture", origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CAD_VIEW_MCP_TOKEN_HEADER]: token,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(CAD_SCREENSHOT_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(
        `CAD screenshot capture request timed out after ${Math.round(
          CAD_SCREENSHOT_HTTP_TIMEOUT_MS / 1000,
        )} seconds before the server responded.`,
        { cause: error },
      );
    }
    throw error;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const suffix = detail ? ` - ${detail}` : "";
    throw new Error(`Failed to capture CAD screenshot: HTTP ${response.status}${suffix}`);
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
        sendControl: postCadControlCommand,
        getHierarchy: postCadHierarchyRequest,
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
