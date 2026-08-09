import { ThreadId } from "@cadsense/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearCadProviderThreadAliasesForTests,
  registerCadProviderThreadAlias,
  readProviderResumeThreadId,
  resolveCadRequestThreadId,
  unregisterCadProviderThreadAliases,
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
});
