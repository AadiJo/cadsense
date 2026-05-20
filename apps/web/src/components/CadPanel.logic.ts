import type { OnshapeSyncedCadFile } from "@cadsense/contracts";

export const CAD_MODEL_LOAD_TARGET_MS = 15_000;
export const CAD_MODEL_LOAD_TIMEOUT_MS = 120_000;
export const CAD_VIEWER_MODEL_SIZE_LIMIT_BYTES = 80 * 1024 * 1024;

export function formatCadModelBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown size";
  }
  const mib = bytes / (1024 * 1024);
  if (mib >= 1) {
    return `${mib.toFixed(mib >= 10 ? 1 : 2)} MiB`;
  }
  const kib = bytes / 1024;
  return `${Math.max(1, Math.round(kib))} KiB`;
}

export function getCadModelViewerBlocker(
  files: ReadonlyArray<Pick<OnshapeSyncedCadFile, "relativePath" | "sizeBytes">>,
): string | null {
  const oversizedFile = files.find(
    (file) =>
      typeof file.sizeBytes === "number" && file.sizeBytes > CAD_VIEWER_MODEL_SIZE_LIMIT_BYTES,
  );
  if (oversizedFile) {
    return [
      `The synced CAD preview is ${formatCadModelBytes(oversizedFile.sizeBytes ?? 0)}, above the ${formatCadModelBytes(CAD_VIEWER_MODEL_SIZE_LIMIT_BYTES)} interactive viewer limit.`,
      "CadSense skipped importing it so the rest of the app stays responsive. Sync or export a smaller preview mesh before opening the viewer.",
    ].join(" ");
  }

  const knownSizes = files
    .map((file) => file.sizeBytes)
    .filter((size): size is number => typeof size === "number" && Number.isFinite(size));
  if (knownSizes.length === files.length) {
    const totalBytes = knownSizes.reduce((sum, size) => sum + size, 0);
    if (totalBytes > CAD_VIEWER_MODEL_SIZE_LIMIT_BYTES) {
      return [
        `The synced CAD preview assets total ${formatCadModelBytes(totalBytes)}, above the ${formatCadModelBytes(CAD_VIEWER_MODEL_SIZE_LIMIT_BYTES)} interactive viewer limit.`,
        "CadSense skipped importing them so the rest of the app stays responsive. Sync or export a smaller preview mesh before opening the viewer.",
      ].join(" ");
    }
  }

  return null;
}

export function cadViewerFrameUrl(location: Location = window.location): string {
  return new URL("/cad-viewer-frame", location.href).toString();
}

export function cadViewerFileName(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  const slashIndex = normalized.lastIndexOf("/");
  const leaf = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
  return leaf.trim().length > 0 ? leaf : "model.cad";
}
