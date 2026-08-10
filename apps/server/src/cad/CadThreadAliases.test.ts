import { ThreadId } from "@cadsense/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CAD_THREAD_TOMBSTONE_CAPACITY,
  acquireCadThreadLifecycleGuard,
  clearCadProviderThreadAliasesForTests,
  isCadThreadDeleted,
  markCadThreadCreated,
  markCadThreadDeleted,
  registerCadProviderThreadAlias,
  readProviderResumeThreadId,
  resolveCadRequestThreadId,
  unregisterCadProviderThreadAliases,
  unregisterCadThreadReferences,
} from "./CadThreadAliases.ts";

describe("CadThreadAliases", () => {
  beforeEach(() => {
    clearCadProviderThreadAliasesForTests();
  });

  it("reads Codex provider thread ids from resume cursors", () => {
    expect(readProviderResumeThreadId({ threadId: "provider-thread" })).toBe("provider-thread");
    expect(readProviderResumeThreadId({ threadId: "" })).toBeUndefined();
    expect(readProviderResumeThreadId(null)).toBeUndefined();
  });

  it("maps provider thread ids back to Cadsense thread ids", () => {
    registerCadProviderThreadAlias({
      cadThreadId: ThreadId.make("cadsense-thread-a"),
      ownerThreadId: ThreadId.make("owner-thread-a"),
      resumeCursor: { threadId: "other-provider-thread" },
    });
    registerCadProviderThreadAlias({
      cadThreadId: ThreadId.make("cadsense-thread-b"),
      ownerThreadId: ThreadId.make("owner-thread-b"),
      resumeCursor: { threadId: "provider-thread" },
    });

    expect(resolveCadRequestThreadId(ThreadId.make("provider-thread"))).toBe("cadsense-thread-b");
  });

  it("uses the latest registered mapping when duplicate provider ids exist", () => {
    registerCadProviderThreadAlias({
      cadThreadId: ThreadId.make("stale-cadsense-thread"),
      ownerThreadId: ThreadId.make("owner-thread"),
      resumeCursor: { threadId: "provider-thread" },
    });
    registerCadProviderThreadAlias({
      cadThreadId: ThreadId.make("latest-cadsense-thread"),
      ownerThreadId: ThreadId.make("owner-thread"),
      resumeCursor: { threadId: "provider-thread" },
    });

    expect(resolveCadRequestThreadId(ThreadId.make("provider-thread"))).toBe(
      "latest-cadsense-thread",
    );
  });

  it("leaves canonical Cadsense thread ids unchanged", () => {
    registerCadProviderThreadAlias({
      cadThreadId: ThreadId.make("other-cadsense-thread"),
      ownerThreadId: ThreadId.make("owner-thread"),
      resumeCursor: { threadId: "provider-thread" },
    });

    expect(resolveCadRequestThreadId(ThreadId.make("cadsense-thread"))).toBe("cadsense-thread");
  });

  it("removes aliases when their owning session stops", () => {
    const ownerThreadId = ThreadId.make("owner-thread");
    registerCadProviderThreadAlias({
      cadThreadId: ThreadId.make("cadsense-thread"),
      ownerThreadId,
      resumeCursor: { threadId: "provider-thread" },
    });

    unregisterCadProviderThreadAliases(ownerThreadId);

    expect(resolveCadRequestThreadId(ThreadId.make("provider-thread"))).toBe("provider-thread");
  });

  it("removes an owner's stale alias when its replacement session has no provider thread id", () => {
    const ownerThreadId = ThreadId.make("owner-thread");
    registerCadProviderThreadAlias({
      cadThreadId: ThreadId.make("cadsense-thread"),
      ownerThreadId,
      resumeCursor: { threadId: "stale-provider-thread" },
    });

    registerCadProviderThreadAlias({
      cadThreadId: ThreadId.make("cadsense-thread"),
      ownerThreadId,
      resumeCursor: { resume: "replacement-session" },
    });

    expect(resolveCadRequestThreadId(ThreadId.make("stale-provider-thread"))).toBe(
      "stale-provider-thread",
    );
  });

  it("removes cross-owner aliases that target a deleted CAD thread", () => {
    const parentThreadId = ThreadId.make("parent-thread");
    registerCadProviderThreadAlias({
      cadThreadId: parentThreadId,
      ownerThreadId: ThreadId.make("review-child-thread"),
      resumeCursor: { threadId: "provider-thread" },
    });

    unregisterCadThreadReferences(parentThreadId);

    expect(resolveCadRequestThreadId(ThreadId.make("provider-thread"))).toBe("provider-thread");
  });

  it("allows a newly created thread to reuse a deleted thread id", () => {
    const reusedThreadId = ThreadId.make("reused-thread");

    markCadThreadDeleted(reusedThreadId);
    expect(isCadThreadDeleted(reusedThreadId)).toBe(true);

    markCadThreadCreated(reusedThreadId);
    expect(isCadThreadDeleted(reusedThreadId)).toBe(false);
  });

  it("bounds retained deletion tombstones", () => {
    const oldestThreadId = ThreadId.make("deleted-thread-0");
    for (let index = 0; index <= CAD_THREAD_TOMBSTONE_CAPACITY; index += 1) {
      markCadThreadDeleted(ThreadId.make(`deleted-thread-${index}`));
    }

    expect(isCadThreadDeleted(oldestThreadId)).toBe(false);
    expect(
      isCadThreadDeleted(ThreadId.make(`deleted-thread-${CAD_THREAD_TOMBSTONE_CAPACITY}`)),
    ).toBe(true);
  });

  it("keeps deleted state pinned for an in-flight session after tombstone eviction", () => {
    const delayedThreadId = ThreadId.make("delayed-thread");
    const guard = acquireCadThreadLifecycleGuard(delayedThreadId);
    markCadThreadDeleted(delayedThreadId);
    for (let index = 0; index < CAD_THREAD_TOMBSTONE_CAPACITY; index += 1) {
      markCadThreadDeleted(ThreadId.make(`newer-deleted-thread-${index}`));
    }

    expect(isCadThreadDeleted(delayedThreadId)).toBe(false);
    expect(guard.isDeleted()).toBe(true);
    guard.release();
  });

  it("isolates recreated threads from guards captured by the deleted generation", () => {
    const reusedThreadId = ThreadId.make("reused-while-starting");
    const deletedGeneration = acquireCadThreadLifecycleGuard(reusedThreadId);
    markCadThreadDeleted(reusedThreadId);
    markCadThreadCreated(reusedThreadId);
    const recreatedGeneration = acquireCadThreadLifecycleGuard(reusedThreadId);

    expect(deletedGeneration.isDeleted()).toBe(true);
    expect(recreatedGeneration.isDeleted()).toBe(false);

    deletedGeneration.release();
    recreatedGeneration.release();
  });
});
