import { unzipSync } from "three/examples/jsm/libs/fflate.module.js";

export const MAX_CAD_MODEL_DOWNLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_3MF_ARCHIVE_ENTRIES = 4_096;
export const MAX_3MF_EXPANDED_ENTRY_BYTES = 256 * 1024 * 1024;
export const MAX_3MF_TOTAL_EXPANDED_BYTES = 512 * 1024 * 1024;

interface ThreeMfArchiveEntry {
  readonly name: string;
  readonly size: number;
  readonly originalSize: number;
  readonly compression: number;
}

export interface ThreeMfArchiveStats {
  readonly entries: number;
  readonly expandedBytes: number;
}

function formatLimitError(subject: string, limit: number): Error {
  return new Error(`${subject} exceeds the ${Math.round(limit / (1024 * 1024))} MiB safety limit.`);
}

function createArchiveEntryFilter(includeEntries: boolean): {
  readonly filter: (entry: ThreeMfArchiveEntry) => boolean;
  readonly stats: () => ThreeMfArchiveStats;
} {
  let entries = 0;
  let expandedBytes = 0;

  return {
    filter: (entry) => {
      entries += 1;
      if (entries > MAX_3MF_ARCHIVE_ENTRIES) {
        throw new Error(`3MF archive exceeds the ${MAX_3MF_ARCHIVE_ENTRIES}-entry safety limit.`);
      }
      if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) {
        throw new Error(`3MF archive entry '${entry.name}' has an invalid expanded size.`);
      }
      if (entry.originalSize > MAX_3MF_EXPANDED_ENTRY_BYTES) {
        throw formatLimitError(`3MF archive entry '${entry.name}'`, MAX_3MF_EXPANDED_ENTRY_BYTES);
      }
      expandedBytes += entry.originalSize;
      if (expandedBytes > MAX_3MF_TOTAL_EXPANDED_BYTES) {
        throw formatLimitError("3MF archive contents", MAX_3MF_TOTAL_EXPANDED_BYTES);
      }
      return includeEntries;
    },
    stats: () => ({ entries, expandedBytes }),
  };
}

export function inspectThreeMfArchive(data: Uint8Array): ThreeMfArchiveStats {
  const limiter = createArchiveEntryFilter(false);
  unzipSync(data, { filter: limiter.filter });
  return limiter.stats();
}

export function unzipThreeMfWithinLimits(data: Uint8Array): Record<string, Uint8Array> {
  const limiter = createArchiveEntryFilter(true);
  return unzipSync(data, { filter: limiter.filter });
}

function responseContentLength(response: Response): number | null {
  const rawValue = response.headers.get("content-length");
  if (rawValue === null) {
    return null;
  }
  const value = Number(rawValue);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function readResponseArrayBufferWithinLimit(
  response: Response,
  maximumBytes: number,
): Promise<ArrayBuffer> {
  const contentLength = responseContentLength(response);
  if (contentLength !== null && contentLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw formatLimitError("CAD model download", maximumBytes);
  }
  if (!response.body) {
    return new ArrayBuffer(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw formatLimitError("CAD model download", maximumBytes);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

export async function loadCadModelResourcesWithinLimit<
  Item,
  Result extends { readonly buffer: ArrayBuffer },
>(input: {
  readonly items: ReadonlyArray<Item>;
  readonly maximumBytes: number;
  readonly load: (item: Item, remainingBytes: number) => Promise<Result>;
}): Promise<Result[]> {
  const results: Result[] = [];
  let remainingBytes = input.maximumBytes;
  for (const item of input.items) {
    const result = await input.load(item, remainingBytes);
    if (result.buffer.byteLength > remainingBytes) {
      throw formatLimitError("CAD model download", input.maximumBytes);
    }
    results.push(result);
    remainingBytes -= result.buffer.byteLength;
  }
  return results;
}

export function assertCadModelBuffersWithinLimit(
  buffers: ReadonlyArray<ArrayBuffer>,
  maximumBytes: number,
): void {
  let remainingBytes = maximumBytes;
  for (const buffer of buffers) {
    if (buffer.byteLength > remainingBytes) {
      throw formatLimitError("CAD model data", maximumBytes);
    }
    remainingBytes -= buffer.byteLength;
  }
}
