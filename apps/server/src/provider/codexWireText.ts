/**
 * Best-effort extraction of streamed text deltas from Codex App Server wire
 * payloads. Keeps UX working when Codex MCP / protocol extensions emit
 * non-string deltas (e.g. wrapped blocks) ahead of regenerated schemas.
 */

export function normalizeCodexStreamDelta(delta: unknown): string | undefined {
  if (typeof delta === "string") {
    return delta;
  }
  if (delta === null || delta === undefined) {
    return undefined;
  }
  if (typeof delta === "number" || typeof delta === "boolean") {
    return String(delta);
  }

  if (Array.isArray(delta)) {
    const parts: string[] = [];
    for (const entry of delta) {
      const piece = normalizeCodexStreamDelta(entry);
      if (piece !== undefined && piece.length > 0) {
        parts.push(piece);
      }
    }
    return parts.length > 0 ? parts.join("") : undefined;
  }

  if (typeof delta === "object") {
    const rec = delta as Record<string, unknown>;
    const text = rec.text;
    if (typeof text === "string") {
      return text;
    }

    const fromDeltaField = normalizeCodexStreamDelta(rec.delta);
    if (fromDeltaField !== undefined) {
      return fromDeltaField;
    }

    const fromContent = normalizeCodexStreamDelta(rec.content);
    if (fromContent !== undefined) {
      return fromContent;
    }
  }

  return undefined;
}

export function normalizeCodexTranscriptSnippet(text: unknown): string | undefined {
  return normalizeCodexStreamDelta(text);
}
