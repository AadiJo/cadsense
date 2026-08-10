import { ThreadId } from "@cadsense/contracts";

interface CadThreadAlias {
  readonly cadThreadId: ThreadId;
  readonly ownerThreadId: ThreadId;
}

const aliasByProviderThreadId = new Map<string, CadThreadAlias>();
const providerThreadIdsByOwnerThreadId = new Map<ThreadId, Set<string>>();
const deletedThreadIds = new Set<ThreadId>();

function deleteAlias(providerThreadId: string): void {
  const alias = aliasByProviderThreadId.get(providerThreadId);
  if (!alias) return;
  aliasByProviderThreadId.delete(providerThreadId);
  const ownerIds = providerThreadIdsByOwnerThreadId.get(alias.ownerThreadId);
  ownerIds?.delete(providerThreadId);
  if (ownerIds?.size === 0) {
    providerThreadIdsByOwnerThreadId.delete(alias.ownerThreadId);
  }
}

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
  unregisterCadProviderThreadAliases(input.ownerThreadId);
  const providerThreadId = readProviderResumeThreadId(input.resumeCursor);
  if (!providerThreadId) {
    return;
  }
  const previous = aliasByProviderThreadId.get(providerThreadId);
  if (previous) {
    deleteAlias(providerThreadId);
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
    deleteAlias(providerThreadId);
  }
}

export function unregisterCadThreadReferences(threadId: ThreadId): void {
  unregisterCadProviderThreadAliases(threadId);
  for (const [providerThreadId, alias] of aliasByProviderThreadId) {
    if (alias.cadThreadId === threadId) {
      deleteAlias(providerThreadId);
    }
  }
}

export function markCadThreadDeleted(threadId: ThreadId): void {
  deletedThreadIds.add(threadId);
  unregisterCadThreadReferences(threadId);
}

export function markCadThreadCreated(threadId: ThreadId): void {
  deletedThreadIds.delete(threadId);
}

export function isCadThreadDeleted(threadId: ThreadId): boolean {
  return deletedThreadIds.has(threadId);
}

export function resolveCadRequestThreadId(requestThreadId: ThreadId): ThreadId {
  return aliasByProviderThreadId.get(requestThreadId)?.cadThreadId ?? requestThreadId;
}

export function clearCadProviderThreadAliasesForTests(): void {
  aliasByProviderThreadId.clear();
  providerThreadIdsByOwnerThreadId.clear();
  deletedThreadIds.clear();
}
