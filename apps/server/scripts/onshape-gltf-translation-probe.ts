#!/usr/bin/env bun
// @effect-diagnostics globalConsole:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
/**
 * Live probe: POST Onshape `/…/export/obj` with the same OBJ JSON body the server uses,
 * then poll until DONE / FAILED. Run on Windows (or anywhere) **before** trusting preview sync.
 *
 * Environment:
 *   CADSENSE_ONSHAPE_PROBE_ACCESS_KEY_ID  — API access key id
 *   CADSENSE_ONSHAPE_PROBE_SECRET_KEY     — API secret key
 *   CADSENSE_ONSHAPE_PROBE_BASE_URL       — optional, default https://cad.onshape.com
 *
 * Arguments (all required except --assembly):
 *   --document-id <id> --wvm-kind <w|v|m> --wvm-id <id> --element-id <id>
 *   --assembly        — use assemblies/…/translations (omit for partstudios/…)
 *   --part-id <id>    — optional part id for part exports
 *
 * Example (assembly):
 *   bun run scripts/onshape-gltf-translation-probe.ts -- \\
 *     --document-id a2fdf318a8bb769e9cfabfff --wvm-kind w --wvm-id 2d0616f580089abd8bdbf2c9 \\
 *     --element-id d7d6c9b02ba2fd25dc7915b6 --assembly
 */
import * as Crypto from "node:crypto";

import { onshapeObjExportRequestBody } from "../src/onshape/Layers/OnshapeWorkspace.ts";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing environment variable ${name}`);
    process.exit(2);
  }
  return value;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--assembly") {
      out.assembly = true;
      continue;
    }
    if (a?.startsWith("--")) {
      const key = a.slice(2).replaceAll("-", "");
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        console.error(`Missing value for ${a}`);
        process.exit(2);
      }
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function signHeaders(input: {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query: string;
  readonly accessKeyId: string;
  readonly secretKey: string;
  readonly body?: string;
}): Record<string, string> {
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
}

function getTranslationId(body: unknown): string | null {
  if (body === null || typeof body !== "object") {
    return null;
  }
  const record = body as Record<string, unknown>;
  for (const key of ["id", "translationId", "requestId"] as const) {
    const v = record[key];
    if (typeof v === "string" && v.trim().length > 0) {
      return v;
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

function getFailureReason(body: unknown): string | null {
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

async function onshapeFetchJson(input: {
  readonly baseUrl: string;
  readonly accessKeyId: string;
  readonly secretKey: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: Record<string, unknown>;
}): Promise<unknown> {
  const url = new URL(`${input.baseUrl.replace(/\/+$/u, "")}${input.path}`);
  const bodyStr = input.body !== undefined ? JSON.stringify(input.body) : undefined;
  const headers = signHeaders({
    method: input.method,
    path: url.pathname,
    query: url.search.length > 0 ? url.search.slice(1) : "",
    accessKeyId: input.accessKeyId,
    secretKey: input.secretKey,
  });
  const response = await fetch(url.toString(), {
    method: input.method,
    headers,
    body: bodyStr,
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(`HTTP ${response.status}: ${text}`);
    process.exit(1);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    console.error("Response was not JSON:", text.slice(0, 500));
    process.exit(1);
  }
}

const POLL_MS = 4000;
const MAX_POLLS = 30;

async function main(): Promise<void> {
  const accessKeyId = requireEnv("CADSENSE_ONSHAPE_PROBE_ACCESS_KEY_ID");
  const secretKey = requireEnv("CADSENSE_ONSHAPE_PROBE_SECRET_KEY");
  const baseUrl = process.env.CADSENSE_ONSHAPE_PROBE_BASE_URL?.trim() || "https://cad.onshape.com";

  const args = parseArgs(process.argv.slice(2));
  const documentId = args.documentid;
  const wvmKind = args.wvmkind;
  const wvmId = args.wvmid;
  const elementId = args.elementid;
  const partId = args.partid;

  if (
    typeof documentId !== "string" ||
    typeof wvmKind !== "string" ||
    typeof wvmId !== "string" ||
    typeof elementId !== "string"
  ) {
    console.error(
      "Usage: bun run scripts/onshape-gltf-translation-probe.ts -- --document-id … --wvm-kind w --wvm-id … --element-id … [--assembly] [--part-id …]",
    );
    process.exit(2);
  }

  const did = encodeURIComponent(documentId);
  const wid = encodeURIComponent(wvmId);
  const eid = encodeURIComponent(elementId);
  const path =
    args.assembly === true
      ? `/api/v10/assemblies/d/${did}/${wvmKind}/${wid}/e/${eid}/export/obj`
      : `/api/v10/partstudios/d/${did}/${wvmKind}/${wid}/e/${eid}/export/obj`;

  const entityKind = args.assembly === true ? ("assembly" as const) : ("part" as const);
  const body = onshapeObjExportRequestBody({
    entityKind,
    reference: {
      baseUrl,
      documentId,
      wvmKind: wvmKind as "w" | "v" | "m",
      wvmId,
      elementId,
      ...(typeof partId === "string" ? { partId } : {}),
    },
  });

  console.log("POST", path);
  console.log("Body", JSON.stringify(body, null, 2));

  const created = await onshapeFetchJson({
    baseUrl,
    accessKeyId,
    secretKey,
    method: "POST",
    path,
    body,
  });
  const translationId = getTranslationId(created);
  if (!translationId) {
    console.error("No translation id in response:", JSON.stringify(created, null, 2));
    process.exit(1);
  }
  console.log("Translation id:", translationId);

  let statusBody: unknown = created;
  for (let i = 0; i < MAX_POLLS; i += 1) {
    const status = getTranslationStatus(statusBody);
    console.log(`Poll ${i + 1}: requestState=${status ?? "?"}`);
    if (status === "DONE") {
      console.log("SUCCESS", JSON.stringify(statusBody, null, 2));
      process.exit(0);
    }
    if (status === "FAILED" || status === "CANCELLED") {
      console.error("FAILED:", getFailureReason(statusBody) ?? JSON.stringify(statusBody));
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    statusBody = await onshapeFetchJson({
      baseUrl,
      accessKeyId,
      secretKey,
      method: "GET",
      path: `/api/v10/translations/${encodeURIComponent(translationId)}`,
    });
  }
  console.error("Timed out waiting for translation.");
  process.exit(1);
}

void main();
