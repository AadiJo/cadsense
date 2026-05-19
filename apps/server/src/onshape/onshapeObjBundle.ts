import { unzipSync } from "fflate";

/** Relative directory (from workspace root) for extracted multi-file OBJ exports from Onshape. */
export const ONSHAPE_OBJ_BUNDLE_RELATIVE_PREFIX = "onshape-sync/bundle";

/**
 * Copy into a fresh Uint8Array so index 0 is always the first downloaded byte. Some HttpClient
 * bodies are views with non-zero byteOffset; indexing [0] on the raw view can hide ZIP magic (PK).
 */
export function compactDownloadedBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

export function isZipArchive(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function formatBytesHeadHex(bytes: Uint8Array, maxBytes = 8): string {
  const n = Math.min(maxBytes, bytes.length);
  const parts: string[] = [];
  for (let i = 0; i < n; i += 1) {
    parts.push(bytes[i]!.toString(16).padStart(2, "0"));
  }
  return parts.join(" ");
}

/** Heuristic: first lines look like ASCII Wavefront OBJ (not binary ZIP/STL). */
export function looksLikeObjText(bytes: Uint8Array, sampleBytes = 4096): boolean {
  if (isZipArchive(bytes)) {
    return false;
  }
  const sample = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, Math.min(sampleBytes, bytes.length)),
  );
  if (/^\uFEFF?\s*(#|v\s|vt\s|vn\s|vp\s|f\s|l\s|s\s|g\s|o\s|mg\s|mtllib)/m.test(sample)) {
    return true;
  }
  const head = sample.slice(0, 256);
  // Onshape occasionally returns minimal ASCII payloads in edge cases; reject obvious binary only.
  return head.length > 0 && !asciiSampleHasBinaryControlCharacters(head);
}

/** C0 controls excluding tab (9), LF (10), CR (13) — matches the prior ASCII regex heuristic. */
function asciiSampleHasBinaryControlCharacters(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)!;
    if (c <= 8 || c === 11 || c === 12 || (c >= 14 && c <= 31)) {
      return true;
    }
  }
  return false;
}

export function sanitizeZipEntryPath(name: string): string | null {
  const normalized = name.replaceAll("\\", "/").replace(/^\/+/u, "");
  if (normalized.length === 0 || normalized.includes("\0")) {
    return null;
  }
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      return null;
    }
  }
  return normalized;
}

export type ObjBundleExtraction = {
  readonly files: ReadonlyArray<{ readonly relativePath: string; readonly bytes: Uint8Array }>;
  readonly primaryRelativePath: string;
};

/**
 * Onshape `/export/obj` translations often download as a ZIP (multiple bodies / companion MTL).
 * Expand into `onshape-sync/bundle/...` and pick the largest `.obj` as the primary mesh.
 */
export function extractObjBundleFromZip(zipBytes: Uint8Array): ObjBundleExtraction {
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(zipBytes);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "invalid zip";
    throw new Error(`Onshape OBJ export zip could not be read: ${message}`, { cause });
  }

  const innerFiles: { innerPath: string; bytes: Uint8Array }[] = [];
  for (const [rawName, data] of Object.entries(unzipped)) {
    const safe = sanitizeZipEntryPath(rawName);
    if (safe === null) {
      continue;
    }
    innerFiles.push({ innerPath: safe, bytes: data });
  }

  const objFiles = innerFiles
    .filter((f) => f.innerPath.toLowerCase().endsWith(".obj"))
    .toSorted((a, b) => b.bytes.length - a.bytes.length);

  if (objFiles.length === 0) {
    throw new Error("Onshape OBJ export zip did not contain any .obj files.");
  }

  const primaryInner = objFiles[0]!.innerPath;
  const primaryRelativePath = `${ONSHAPE_OBJ_BUNDLE_RELATIVE_PREFIX}/${primaryInner}`;
  const files = innerFiles.map((f) => ({
    relativePath: `${ONSHAPE_OBJ_BUNDLE_RELATIVE_PREFIX}/${f.innerPath}`,
    bytes: f.bytes,
  }));

  return { files, primaryRelativePath };
}

export function tryExtractObjBundle(bytes: Uint8Array): ObjBundleExtraction | null {
  try {
    return extractObjBundleFromZip(bytes);
  } catch {
    return null;
  }
}
