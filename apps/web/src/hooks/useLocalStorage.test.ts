import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("persistLocalStorageUpdate", () => {
  it("applies consecutive functional updates against the latest persisted value", async () => {
    const localStorage = createLocalStorageStub();
    vi.stubGlobal("window", { localStorage });
    const { persistLocalStorageUpdate } = await import("./useLocalStorage");
    const updater = vi.fn((value: number) => value + 1);

    let current = persistLocalStorageUpdate("count", 0, updater, Schema.Number);
    current = persistLocalStorageUpdate("count", current, updater, Schema.Number);

    expect(current).toBe(2);
    expect(updater).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("count")).toBe("2");
  });

  it("surfaces storage failures before returning a new state value", async () => {
    const localStorage = createLocalStorageStub();
    localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    vi.stubGlobal("window", { localStorage });
    const { persistLocalStorageUpdate } = await import("./useLocalStorage");

    expect(() => persistLocalStorageUpdate("count", 1, 2, Schema.Number)).toThrow("quota exceeded");
  });
});
