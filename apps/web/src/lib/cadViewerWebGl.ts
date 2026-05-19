/**
 * User-facing copy when the CAD viewer (online-3d-viewer / WebGL1) cannot start.
 * Chromium often logs `WebGL1 blocklisted` when the GPU is on the blocklist.
 */
export function buildCadWebGlFailureUserMessage(viewerMessage: string | null | undefined): string {
  const raw = (viewerMessage ?? "").trim();
  if (raw.length === 0) {
    return defaultWebGlBlockedMessage();
  }
  const lower = raw.toLowerCase();
  if (
    lower.includes("webgl") ||
    lower.includes("gpu") ||
    lower.includes("blocklist") ||
    lower.includes("context")
  ) {
    return defaultWebGlBlockedMessage();
  }
  return raw;
}

function defaultWebGlBlockedMessage(): string {
  return "WebGL could not be initialized. Chromium may have blocklisted this GPU or driver. The desktop app requests “ignore GPU blocklist”; if you still see this, update GPU drivers or try another machine or browser profile.";
}

/** Returns `null` when a WebGL1 context can be created, otherwise a user-facing reason. */
export function getWebGl1UnavailableReason(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.createElement("canvas");
  const gl =
    canvas.getContext("webgl", { failIfMajorPerformanceCaveat: false }) ??
    canvas.getContext("experimental-webgl" as "webgl");
  return gl ? null : buildCadWebGlFailureUserMessage(null);
}
