import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";

import {
  compactDownloadedBytes,
  extractObjBundleFromZip,
  isZipArchive,
  sanitizeZipEntryPath,
} from "./onshapeObjBundle.ts";

describe("onshapeObjBundle", () => {
  it("detects zip local-file headers", () => {
    const zipBytes = zipSync({ "a.obj": new TextEncoder().encode("v") });
    expect(isZipArchive(zipBytes)).toBe(true);
    expect(isZipArchive(new TextEncoder().encode("v 0 0 0\n"))).toBe(false);
  });

  it("compactDownloadedBytes copies into a distinct ArrayBuffer", () => {
    const original = new TextEncoder().encode("OBJ-DATA");
    const copy = compactDownloadedBytes(original);
    expect(copy.buffer).not.toBe(original.buffer);
    expect(Array.from(copy)).toEqual(Array.from(original));
  });

  it("rejects path traversal in zip entry names", () => {
    expect(sanitizeZipEntryPath("../evil.obj")).toBe(null);
    expect(sanitizeZipEntryPath("good/nested.obj")).toBe("good/nested.obj");
  });

  it("extractObjBundleFromZip picks the largest obj as primary", () => {
    const zipBytes = zipSync({
      "small.obj": new TextEncoder().encode("v"),
      "large.obj": new TextEncoder().encode("v\n".repeat(20)),
    });
    const extracted = extractObjBundleFromZip(zipBytes);
    expect(extracted.primaryRelativePath).toBe("onshape-sync/bundle/large.obj");
    expect(extracted.files.some((f) => f.relativePath.endsWith("small.obj"))).toBe(true);
  });
});
