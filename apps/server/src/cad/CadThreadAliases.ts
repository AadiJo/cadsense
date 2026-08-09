import { ThreadId } from "@cadsense/contracts";

interface CadThreadAlias {
  readonly cadThreadId: ThreadId;
  readonly ownerThreadId: ThreadId;
}

const aliasByProviderThreadId = new Map<string, CadThreadAlias>();
const providerThreadIdsByOwnerThreadId = new Map<ThreadId, Set<string>>();

export function readProviderResumeThreadId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const threadId = (resumeCursor as { readonly threadId?: unknown }).threadId;
  return typeof threadId === "string" && threadId.trim().length > 0 ? threadId : undefined;
}

export function registerCadProviderThreadAlias(input: {
  readonly cadThreadId: ThreadId;
  readonly ownerThreadId: ThreadId;
  readonly resumeCursor: unknown;
}): void {
  const providerThreadId = readProviderResumeThreadId(input.resumeCursor);
  if (!providerThreadId) {
    return;
  }
  unregisterCadProviderThreadAliases(input.ownerThreadId);
  const previous = aliasByProviderThreadId.get(providerThreadId);
  if (previous) {
    const previousOwnerIds = providerThreadIdsByOwnerThreadId.get(previous.ownerThreadId);
    previousOwnerIds?.delete(providerThreadId);
    if (previousOwnerIds?.size === 0) {
      providerThreadIdsByOwnerThreadId.delete(previous.ownerThreadId);
    }
  }
  aliasByProviderThreadId.set(providerThreadId, {
    cadThreadId: input.cadThreadId,
    ownerThreadId: input.ownerThreadId,
  });
  providerThreadIdsByOwnerThreadId.set(input.ownerThreadId, new Set([providerThreadId]));
}

export function unregisterCadProviderThreadAliases(ownerThreadId: ThreadId): void {
  const providerThreadIds = providerThreadIdsByOwnerThreadId.get(ownerThreadId);
  if (!providerThreadIds) return;
  for (const providerThreadId of providerThreadIds) {
    aliasByProviderThreadId.delete(providerThreadId);
  }
  providerThreadIdsByOwnerThreadId.delete(ownerThreadId);
}

export function resolveCadRequestThreadId(requestThreadId: ThreadId): ThreadId {
  return aliasByProviderThreadId.get(requestThreadId)?.cadThreadId ?? requestThreadId;
}

export function clearCadProviderThreadAliasesForTests(): void {
  aliasByProviderThreadId.clear();
  providerThreadIdsByOwnerThreadId.clear();
}
