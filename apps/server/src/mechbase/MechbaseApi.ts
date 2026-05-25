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
