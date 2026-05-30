import { describe, expect, it } from "vitest";

import { threadHasProviderWorkStarted } from "./threadLifecycle";
import type { Thread, ThreadSession } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    latestTurn: null,
    messages: [],
    session: null,
    ...overrides,
  } as Thread;
}

function makeSession(overrides: Partial<ThreadSession>): ThreadSession {
  return {
    orchestrationStatus: "ready",
    activeTurnId: null,
    ...overrides,
  } as ThreadSession;
}

describe("threadHasProviderWorkStarted", () => {
  it("does not promote drafts for pending or ready-only server state", () => {
    expect(
      threadHasProviderWorkStarted(
        makeThread({
          pendingTurnStartedAt: "2026-05-30T18:22:09.958Z",
        }),
      ),
    ).toBe(false);
    expect(
      threadHasProviderWorkStarted(
        makeThread({
          session: makeSession({ orchestrationStatus: "ready" }),
        }),
      ),
    ).toBe(false);
  });

  it("promotes drafts once a provider turn or assistant output exists", () => {
    expect(
      threadHasProviderWorkStarted(
        makeThread({
          session: makeSession({ orchestrationStatus: "running" }),
        }),
      ),
    ).toBe(true);
    expect(
      threadHasProviderWorkStarted(
        makeThread({
          latestTurn: {} as Thread["latestTurn"],
        }),
      ),
    ).toBe(true);
    expect(
      threadHasProviderWorkStarted(
        makeThread({
          messages: [{ role: "assistant" }] as Thread["messages"],
        }),
      ),
    ).toBe(true);
  });
});
