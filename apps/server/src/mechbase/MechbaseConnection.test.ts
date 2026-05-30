import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

import {
  clearMechbaseApiKeyValidationCacheForTests,
  encodeMechbaseApiKey,
  getCachedValidatedMechbaseApiKey,
} from "./MechbaseConnection.ts";

describe("MechbaseConnection", () => {
  afterEach(() => {
    clearMechbaseApiKeyValidationCacheForTests();
  });

  it("reuses successful API key validation within the cache TTL", async () => {
    const validate = vi.fn(async () => ({ scopes: ["search:read"] }));
    const storedApiKey = encodeMechbaseApiKey("secret");

    await Effect.runPromise(
      getCachedValidatedMechbaseApiKey(storedApiKey, {
        now: () => 1_000,
        validate,
      }),
    );
    await Effect.runPromise(
      getCachedValidatedMechbaseApiKey(storedApiKey, {
        now: () => 2_000,
        validate,
      }),
    );

    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("validates again after the cache TTL expires", async () => {
    const validate = vi.fn(async () => ({ scopes: ["search:read"] }));
    const storedApiKey = encodeMechbaseApiKey("secret");

    await Effect.runPromise(
      getCachedValidatedMechbaseApiKey(storedApiKey, {
        now: () => 1_000,
        validate,
      }),
    );
    await Effect.runPromise(
      getCachedValidatedMechbaseApiKey(storedApiKey, {
        now: () => 1_000 + 5 * 60 * 1000 + 1,
        validate,
      }),
    );

    expect(validate).toHaveBeenCalledTimes(2);
  });
});
