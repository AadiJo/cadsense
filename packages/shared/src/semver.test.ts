import { describe, expect, it } from "vitest";

import {
  compareSemverVersions,
  normalizeSemverVersion,
  parseSemver,
  satisfiesSemverRange,
} from "./semver.ts";

describe("semver helpers", () => {
  it("matches supported range groups", () => {
    const range = "^22.16 || ^23.11 || >=24.10";

    expect(satisfiesSemverRange("22.16.0", range)).toBe(true);
    expect(satisfiesSemverRange("23.11.1", range)).toBe(true);
    expect(satisfiesSemverRange("24.10.0", range)).toBe(true);
    expect(satisfiesSemverRange("22.15.9", range)).toBe(false);
    expect(satisfiesSemverRange("23.10.9", range)).toBe(false);
    expect(satisfiesSemverRange("24.9.9", range)).toBe(false);
  });

  it("normalizes versions with a missing patch segment", () => {
    expect(normalizeSemverVersion("2.1")).toBe("2.1.0");
  });

  it("compares prerelease versions before stable versions", () => {
    expect(compareSemverVersions("2.1.111-beta.1", "2.1.111")).toBeLessThan(0);
  });

  it("preserves hyphens inside prerelease identifiers", () => {
    expect(normalizeSemverVersion("2.1-beta-feature.1")).toBe("2.1.0-beta-feature.1");
    expect(compareSemverVersions("2.1.0-beta-feature.1", "2.1.0-beta-feature.2")).toBeLessThan(0);
  });

  it("preserves and ignores build metadata when comparing versions", () => {
    expect(normalizeSemverVersion("2.1-beta-feature+build-7")).toBe("2.1.0-beta-feature+build-7");
    expect(compareSemverVersions("2.1.0-beta-feature+build-7", "2.1.0-beta-feature+build-8")).toBe(
      0,
    );
    expect(compareSemverVersions("2.1.0+build-7", "2.1.0")).toBe(0);
  });

  it("rejects malformed core and prerelease identifiers", () => {
    expect(parseSemver("01.2.3")).toBeNull();
    expect(parseSemver("1..2.3")).toBeNull();
    expect(parseSemver(".1.2.3")).toBeNull();
    expect(parseSemver("1.2.3.")).toBeNull();
    expect(parseSemver("1.2.3-alpha..1")).toBeNull();
    expect(parseSemver("1.2.3-alpha.01")).toBeNull();
    expect(parseSemver("1.2.3-alpha_1")).toBeNull();
    expect(parseSemver("1 .2.3")).toBeNull();
  });

  it("compares arbitrarily large numeric identifiers without losing precision", () => {
    expect(compareSemverVersions("9007199254740992.0.0", "9007199254740993.0.0")).toBeLessThan(0);
    expect(compareSemverVersions("1.0.0-9007199254740992", "1.0.0-9007199254740993")).toBeLessThan(
      0,
    );
    expect(
      compareSemverVersions("99999999999999999999.0.0", "100000000000000000000.0.0"),
    ).toBeLessThan(0);
  });

  it("sorts malformed versions below valid versions and lexically among themselves", () => {
    expect(compareSemverVersions("1.2.3abc", "1.2.10")).toBeLessThan(0);
    expect(compareSemverVersions("also-invalid", "not-a-version")).toBeLessThan(0);
  });

  it("maintains a transitive ordering across valid and malformed versions", () => {
    const ordered = ["15.invalid", "2.0.0", "10.0.0", "10.0.0-alpha", "10.0.0"];
    ordered.sort(compareSemverVersions);

    for (let left = 0; left < ordered.length; left += 1) {
      for (let middle = left; middle < ordered.length; middle += 1) {
        for (let right = middle; right < ordered.length; right += 1) {
          expect(compareSemverVersions(ordered[left]!, ordered[middle]!)).toBeLessThanOrEqual(0);
          expect(compareSemverVersions(ordered[middle]!, ordered[right]!)).toBeLessThanOrEqual(0);
          expect(compareSemverVersions(ordered[left]!, ordered[right]!)).toBeLessThanOrEqual(0);
        }
      }
    }
  });

  it("supports comparison comparators", () => {
    expect(satisfiesSemverRange("24.9.0", ">=24.0 <24.10")).toBe(true);
    expect(satisfiesSemverRange("24.10.0", ">=24.0 <24.10")).toBe(false);
  });

  it("honors caret range upper bounds for zero-major versions", () => {
    expect(satisfiesSemverRange("0.2.3", "^0.2.3")).toBe(true);
    expect(satisfiesSemverRange("0.2.9", "^0.2.3")).toBe(true);
    expect(satisfiesSemverRange("0.3.0", "^0.2.3")).toBe(false);
    expect(satisfiesSemverRange("0.5.0", "^0.2.3")).toBe(false);
    expect(satisfiesSemverRange("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfiesSemverRange("0.0.4", "^0.0.3")).toBe(false);
  });

  it("rejects invalid versions and unsupported range syntax", () => {
    expect(satisfiesSemverRange("not-a-version", ">=24.0")).toBe(false);
    expect(satisfiesSemverRange("24.10.0", "~24.10")).toBe(false);
  });

  it("keeps the range checker stringifiable and executable as plain JavaScript", () => {
    const source = satisfiesSemverRange.toString();
    const recreated = Function(`return (${source});`)() as typeof satisfiesSemverRange;

    expect(source).toContain("function satisfiesSemverRange");
    expect(source).not.toContain(": string");
    expect(source).not.toContain(": boolean");
    expect(recreated("24.10.0", ">=24.10")).toBe(true);
    expect(recreated("24.9.9", ">=24.10")).toBe(false);
  });
});
