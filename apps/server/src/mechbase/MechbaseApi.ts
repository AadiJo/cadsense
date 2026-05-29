import sharp from "sharp";
import { JpxImage } from "jpeg2000";

export const MECHBASE_PUBLIC_API_BASE_URL = "https://api-frcrag-v2.johari-dev.com";
export const MECHBASE_API_KEY_ENV = "MECHBASE_API_KEY";
export const MECHBASE_API_KEY_SECRET_NAME = "mechbase-api-key";

export type MechbaseFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface MechbaseValidationResult {
  readonly valid: true;
  readonly apiKeyId: string;
  readonly workspaceId: string;
  readonly permissions: ReadonlyArray<string>;
}

export interface MechbaseSearchInput {
  readonly query: string;
  readonly top_k?: number;
  readonly team?: string;
  readonly year?: number;
  readonly source?: string;
  readonly modality?: "text" | "page_image" | "extracted_image";
  readonly debug?: boolean;
}

export interface MechbaseSearchResult {
  readonly results?: ReadonlyArray<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface MechbaseArtifactFetchInput {
  readonly artifactUrl: string;
}

export interface MechbaseArtifactFetchResult {
  readonly artifactUrl: string;
  readonly mimeType: string;
  readonly data: Uint8Array;
  readonly sizeBytes: number;
}

const MAX_MECHBASE_ARTIFACT_BYTES = 8 * 1024 * 1024;
const BROWSER_PREVIEWABLE_MECHBASE_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/svg+xml",
  "image/webp",
]);
const JPEG_2000_MECHBASE_IMAGE_MIME_TYPES = new Set([
  "image/j2c",
  "image/j2k",
  "image/jp2",
  "image/jpx",
  "image/x-jp2",
  "image/x-jpx",
]);
const MECHBASE_IMAGE_MIME_BY_EXTENSION = new Map<string, string>([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".j2c", "image/j2c"],
  [".j2k", "image/j2k"],
  [".jp2", "image/jp2"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".jpx", "image/jpx"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".webp", "image/webp"],
]);

function mechbaseUrl(path: string): string {
  return new URL(path, MECHBASE_PUBLIC_API_BASE_URL).toString();
}

async function readErrorBody(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  if (!body.trim()) return `HTTP ${response.status}`;
  return `HTTP ${response.status}: ${body}`;
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid response.`);
  }
}

export function normalizeMechbaseSearchInput(input: unknown): MechbaseSearchInput {
  assertObject(input, "Mechbase search input");
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (query.length === 0) {
    throw new Error("Mechbase search requires a non-empty query.");
  }
  const output: MechbaseSearchInput = { query };
  if (input.top_k !== undefined) {
    const topK = input.top_k;
    if (typeof topK !== "number" || !Number.isInteger(topK) || topK < 1 || topK > 100) {
      throw new Error("Mechbase top_k must be an integer from 1 to 100.");
    }
    Object.assign(output, { top_k: topK });
  }
  for (const key of ["team", "source"] as const) {
    const value = input[key];
    if (value !== undefined) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`Mechbase ${key} must be a non-empty string.`);
      }
      Object.assign(output, { [key]: value.trim() });
    }
  }
  if (input.year !== undefined) {
    if (!Number.isInteger(input.year)) {
      throw new Error("Mechbase year must be an integer.");
    }
    Object.assign(output, { year: input.year });
  }
  if (input.modality !== undefined) {
    if (
      input.modality !== "text" &&
      input.modality !== "page_image" &&
      input.modality !== "extracted_image"
    ) {
      throw new Error("Mechbase modality must be text, page_image, or extracted_image.");
    }
    Object.assign(output, { modality: input.modality });
  }
  if (input.debug !== undefined) {
    if (typeof input.debug !== "boolean") {
      throw new Error("Mechbase debug must be a boolean.");
    }
    Object.assign(output, { debug: input.debug });
  }
  return output;
}

export function resolveMechbaseUrl(value: unknown): unknown {
  if (typeof value !== "string" || !value.startsWith("/")) {
    return value;
  }
  return mechbaseUrl(value);
}

function normalizeMechbaseArtifactUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Mechbase artifactUrl must be a non-empty string.");
  }
  const resolved = resolveMechbaseUrl(value.trim());
  if (typeof resolved !== "string") {
    throw new Error("Mechbase artifactUrl must be a string.");
  }
  const parsed = new URL(resolved);
  const allowedOrigin = new URL(MECHBASE_PUBLIC_API_BASE_URL).origin;
  if (parsed.origin !== allowedOrigin) {
    throw new Error("Mechbase artifactUrl must point to the configured Mechbase API origin.");
  }
  return parsed.toString();
}

export function normalizeMechbaseArtifactFetchInput(input: unknown): MechbaseArtifactFetchInput {
  assertObject(input, "Mechbase artifact fetch input");
  return { artifactUrl: normalizeMechbaseArtifactUrl(input.artifactUrl) };
}

function normalizeSearchResultUrls(result: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...result };
  for (const key of ["artifact_url", "page_context_url", "page_text_url"] as const) {
    normalized[key] = resolveMechbaseUrl(normalized[key]);
  }
  if (Array.isArray(normalized.linked_artifact_urls)) {
    normalized.linked_artifact_urls = normalized.linked_artifact_urls.map(resolveMechbaseUrl);
  }
  return normalized;
}

function inferMechbaseImageMimeType(artifactUrl: string, responseContentType: string): string {
  if (responseContentType.startsWith("image/")) {
    return responseContentType;
  }
  if (
    responseContentType !== "" &&
    responseContentType !== "application/octet-stream" &&
    responseContentType !== "binary/octet-stream"
  ) {
    return responseContentType;
  }
  const pathname = new URL(artifactUrl).pathname.toLowerCase();
  const extension = pathname.match(/\.[a-z0-9]+$/i)?.[0];
  return extension
    ? (MECHBASE_IMAGE_MIME_BY_EXTENSION.get(extension) ?? responseContentType)
    : responseContentType;
}

async function convertMechbaseArtifactForBrowserPreview(input: {
  readonly data: Uint8Array;
  readonly mimeType: string;
}): Promise<{ readonly data: Uint8Array; readonly mimeType: string }> {
  if (BROWSER_PREVIEWABLE_MECHBASE_IMAGE_MIME_TYPES.has(input.mimeType)) {
    return input;
  }

  try {
    const converted = await sharp(input.data).png().toBuffer();
    return {
      data: new Uint8Array(converted),
      mimeType: "image/png",
    };
  } catch (cause) {
    if (JPEG_2000_MECHBASE_IMAGE_MIME_TYPES.has(input.mimeType)) {
      try {
        return await convertJpeg2000MechbaseArtifactForBrowserPreview(input.data);
      } catch (jpeg2000Cause) {
        const sharpMessage = cause instanceof Error ? cause.message : "unknown conversion error";
        const jpeg2000Message =
          jpeg2000Cause instanceof Error
            ? jpeg2000Cause.message
            : "unknown JPEG 2000 conversion error";
        throw new Error(
          `Mechbase artifact image format (${input.mimeType}) is not browser-previewable. Sharp conversion failed: ${sharpMessage}. JPEG 2000 fallback failed: ${jpeg2000Message}`,
          { cause: jpeg2000Cause },
        );
      }
    }
    const message = cause instanceof Error ? cause.message : "unknown conversion error";
    throw new Error(
      `Mechbase artifact image format (${input.mimeType}) is not browser-previewable and conversion to PNG failed: ${message}`,
      { cause },
    );
  }
}

async function convertJpeg2000MechbaseArtifactForBrowserPreview(
  data: Uint8Array,
): Promise<{ readonly data: Uint8Array; readonly mimeType: string }> {
  const image = new JpxImage();
  image.parse(Buffer.from(data));

  if (!Number.isInteger(image.width) || image.width <= 0) {
    throw new Error("JPEG 2000 image width is invalid.");
  }
  if (!Number.isInteger(image.height) || image.height <= 0) {
    throw new Error("JPEG 2000 image height is invalid.");
  }
  if (
    !Number.isInteger(image.componentsCount) ||
    image.componentsCount < 1 ||
    image.componentsCount > 4
  ) {
    throw new Error(`JPEG 2000 component count is unsupported: ${image.componentsCount}.`);
  }
  if (image.tiles.length === 0) {
    throw new Error("JPEG 2000 image has no decoded tiles.");
  }

  const channels = image.componentsCount as 1 | 2 | 3 | 4;
  const raw = new Uint8Array(image.width * image.height * channels);
  for (const tile of image.tiles) {
    const rowSize = tile.width * channels;
    for (let y = 0; y < tile.height; y += 1) {
      const sourceStart = y * rowSize;
      const targetStart = ((tile.top + y) * image.width + tile.left) * channels;
      raw.set(tile.items.subarray(sourceStart, sourceStart + rowSize), targetStart);
    }
  }

  const converted = await sharp(raw, {
    raw: {
      width: image.width,
      height: image.height,
      channels,
    },
  })
    .png()
    .toBuffer();
  return {
    data: new Uint8Array(converted),
    mimeType: "image/png",
  };
}

export async function validateMechbaseApiKey(
  apiKey: string,
  fetchImpl: MechbaseFetch = fetch,
): Promise<MechbaseValidationResult> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new Error("Mechbase API key is required.");
  }
  const response = await fetchImpl(mechbaseUrl("/auth/validate"), {
    headers: { Authorization: `Bearer ${trimmed}` },
  });
  if (!response.ok) {
    throw new Error(`Mechbase API key validation failed: ${await readErrorBody(response)}`);
  }
  const body: unknown = await response.json();
  assertObject(body, "Mechbase validation");
  if (body.valid !== true) {
    throw new Error("Mechbase API key is invalid.");
  }
  if (typeof body.apiKeyId !== "string" || typeof body.workspaceId !== "string") {
    throw new Error("Mechbase validation returned incomplete credentials metadata.");
  }
  if (
    !Array.isArray(body.permissions) ||
    !body.permissions.every((item) => typeof item === "string")
  ) {
    throw new Error("Mechbase validation returned invalid permissions metadata.");
  }
  if (!body.permissions.includes("search:read")) {
    throw new Error("Mechbase API key is missing the search:read permission.");
  }
  return {
    valid: true,
    apiKeyId: body.apiKeyId,
    workspaceId: body.workspaceId,
    permissions: body.permissions,
  };
}

export async function searchMechbase(
  input: unknown,
  apiKey: string,
  fetchImpl: MechbaseFetch = fetch,
): Promise<MechbaseSearchResult> {
  const normalizedInput = normalizeMechbaseSearchInput(input);
  const response = await fetchImpl(mechbaseUrl("/search"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(normalizedInput),
  });
  if (!response.ok) {
    throw new Error(`Mechbase search failed: ${await readErrorBody(response)}`);
  }
  const body: unknown = await response.json();
  assertObject(body, "Mechbase search");
  const results = Array.isArray(body.results)
    ? body.results.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? normalizeSearchResultUrls(item as Record<string, unknown>)
          : item,
      )
    : undefined;
  return {
    ...body,
    ...(results ? { results } : {}),
  } as MechbaseSearchResult;
}

export async function fetchMechbaseArtifact(
  input: unknown,
  apiKey: string,
  fetchImpl: MechbaseFetch = fetch,
): Promise<MechbaseArtifactFetchResult> {
  const normalizedInput = normalizeMechbaseArtifactFetchInput(input);
  const response = await fetchImpl(normalizedInput.artifactUrl, {
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
  });
  if (!response.ok) {
    throw new Error(`Mechbase artifact fetch failed: ${await readErrorBody(response)}`);
  }
  const responseContentType =
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const mimeType = inferMechbaseImageMimeType(normalizedInput.artifactUrl, responseContentType);
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Mechbase artifact is not an image: ${mimeType || "unknown content type"}.`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const size = Number(contentLength);
    if (Number.isFinite(size) && size > MAX_MECHBASE_ARTIFACT_BYTES) {
      throw new Error("Mechbase artifact image is too large.");
    }
  }
  const originalData = new Uint8Array(await response.arrayBuffer());
  if (originalData.byteLength > MAX_MECHBASE_ARTIFACT_BYTES) {
    throw new Error("Mechbase artifact image is too large.");
  }
  const { data, mimeType: previewMimeType } = await convertMechbaseArtifactForBrowserPreview({
    data: originalData,
    mimeType,
  });
  if (data.byteLength > MAX_MECHBASE_ARTIFACT_BYTES) {
    throw new Error("Mechbase artifact image is too large after conversion.");
  }
  return {
    artifactUrl: normalizedInput.artifactUrl,
    mimeType: previewMimeType,
    data,
    sizeBytes: data.byteLength,
  };
}
