import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchLatestRelease, type Release } from "./releases.ts";

const CACHE_KEY = "cadsense-latest-release";
const release: Release = {
  tag_name: "v1.2.3",
  html_url: "https://github.com/AadiJo/Cadsense/releases/tag/v1.2.3",
  assets: [
    {
      name: "cadsense.exe",
      browser_download_url: "https://example.test/cadsense.exe",
    },
  ],
};

describe("fetchLatestRelease", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects unsuccessful GitHub responses after discarding invalid cache data", async () => {
    values.set(CACHE_KEY, "not-json");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 403 })),
    );

    await expect(fetchLatestRelease()).rejects.toThrow("status 403");
    expect(values.has(CACHE_KEY)).toBe(false);
  });

  it("validates successful responses before caching them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(release)),
    );

    await expect(fetchLatestRelease()).resolves.toEqual(release);
    expect(JSON.parse(values.get(CACHE_KEY) ?? "null")).toEqual(release);
  });

  it("ignores malformed cached objects", async () => {
    values.set(CACHE_KEY, JSON.stringify({ tag_name: "v1.2.3" }));
    const fetchMock = vi.fn(async () => Response.json(release));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchLatestRelease()).resolves.toEqual(release);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
