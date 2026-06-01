import { ThreadId } from "@cadsense/contracts";

const cadThreadIdByProviderThreadId = new Map<string, ThreadId>();

export function readProviderResumeThreadId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const threadId = (resumeCursor as { readonly threadId?: unknown }).threadId;
  return typeof threadId === "string" && threadId.trim().length > 0 ? threadId : undefined;
}

export function registerCadProviderThreadAlias(input: {
  readonly cadThreadId: ThreadId;
  readonly resumeCursor: unknown;
}): void {
  const providerThreadId = readProviderResumeThreadId(input.resumeCursor);
  if (!providerThreadId) {
    return;
  }
  cadThreadIdByProviderThreadId.set(providerThreadId, input.cadThreadId);
}

export function resolveCadRequestThreadId(requestThreadId: ThreadId): ThreadId {
  return cadThreadIdByProviderThreadId.get(requestThreadId) ?? requestThreadId;
}

export function clearCadProviderThreadAliasesForTests(): void {
  cadThreadIdByProviderThreadId.clear();
}
