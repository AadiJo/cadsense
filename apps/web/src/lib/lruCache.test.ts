import { describe, expect, it } from "vitest";
import { LRUCache } from "./lruCache";

describe("LRUCache", () => {
  it("returns null for missing keys", () => {
    const cache = new LRUCache<string>(2, 100);
    expect(cache.get("missing")).toBeNull();
  });

  it("evicts oldest by max entries", () => {
    const cache = new LRUCache<string>(2, 1_000);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);
    cache.set("c", "C", 10);

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
  });

  it("promotes on get and evicts least recently used", () => {
    const cache = new LRUCache<string>(2, 1_000);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);
    expect(cache.get("a")).toBe("A");

    cache.set("c", "C", 10);
    expect(cache.get("a")).toBe("A");
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBe("C");
  });

  it("evicts by memory budget", () => {
    const cache = new LRUCache<string>(10, 25);
    cache.set("a", "A", 10);
    cache.set("b", "B", 10);
    cache.set("c", "C", 10);

    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
  });

  it("does not retain an entry larger than the memory budget", () => {
    const cache = new LRUCache<string>(10, 25);
    cache.set("a", "A", 10);
    cache.set("oversized", "too large", 26);

    expect(cache.get("a")).toBe("A");
    expect(cache.get("oversized")).toBeNull();
  });

  it("removes an existing entry when its replacement is oversized", () => {
    const cache = new LRUCache<string>(10, 25);
    cache.set("a", "A", 10);
    cache.set("a", "too large", 26);

    expect(cache.get("a")).toBeNull();
  });

  it("rejects invalid sizes without poisoning memory accounting", () => {
    const cache = new LRUCache<string>(10, 25);
    cache.set("negative", "invalid", -100);
    cache.set("not-a-number", "invalid", Number.NaN);
    cache.set("a", "A", 20);
    cache.set("b", "B", 10);

    expect(cache.get("negative")).toBeNull();
    expect(cache.get("not-a-number")).toBeNull();
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("B");
  });

  it("rejects fractional and unsafe integer size estimates", () => {
    const cache = new LRUCache<string>(10, Number.POSITIVE_INFINITY);
    cache.set("fractional", "invalid", 0.5);
    cache.set("unsafe", "invalid", Number.MAX_SAFE_INTEGER + 1);
    cache.set("valid", "valid", Number.MAX_SAFE_INTEGER);

    expect(cache.get("fractional")).toBeNull();
    expect(cache.get("unsafe")).toBeNull();
    expect(cache.get("valid")).toBe("valid");
  });

  it("does not retain entries when either configured budget is disabled or invalid", () => {
    const caches = [
      new LRUCache<string>(0, 100),
      new LRUCache<string>(10, 0),
      new LRUCache<string>(Number.NaN, 100),
      new LRUCache<string>(10, Number.NaN),
      new LRUCache<string>(1.5, 100),
    ];

    for (const cache of caches) {
      cache.set("entry", "value", 1);
      expect(cache.get("entry")).toBeNull();
    }
  });

  it("supports explicitly unbounded entry and memory budgets", () => {
    const cache = new LRUCache<string>(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    cache.set("a", "A", Number.MAX_SAFE_INTEGER);
    cache.set("b", "B", Number.MAX_SAFE_INTEGER);

    expect(cache.get("a")).toBe("A");
    expect(cache.get("b")).toBe("B");
  });
});
