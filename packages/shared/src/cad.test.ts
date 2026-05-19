import { describe, expect, it } from "vitest";

import {
  DEFAULT_ONSHAPE_SYNC_MODEL_PATH,
  isObjPreviewCompanionPath,
  isOnshapeSyncRelativePath,
  isSupportedCadModelPath,
  parseMtlReferencedAssetFilenames,
  parseObjMtllibFilenames,
} from "./cad.js";

describe("cad shared helpers", () => {
  it("recognizes supported CAD model paths case-insensitively", () => {
    expect(isSupportedCadModelPath(DEFAULT_ONSHAPE_SYNC_MODEL_PATH)).toBe(true);
    expect(isSupportedCadModelPath("onshape-sync/assembly.STP")).toBe(true);
    expect(isSupportedCadModelPath("onshape-sync/materials.mtl")).toBe(true);
    expect(isSupportedCadModelPath("onshape-sync/diffuse.PNG")).toBe(true);
    expect(isSupportedCadModelPath("onshape-sync/readme.txt")).toBe(false);
  });

  it("recognizes paths scoped to onshape-sync", () => {
    expect(isOnshapeSyncRelativePath(DEFAULT_ONSHAPE_SYNC_MODEL_PATH)).toBe(true);
    expect(isOnshapeSyncRelativePath("onshape-sync/current.step")).toBe(true);
    expect(isOnshapeSyncRelativePath("/onshape-sync/current.obj")).toBe(true);
    expect(isOnshapeSyncRelativePath("elsewhere/current.step")).toBe(false);
  });

  it("recognizes OBJ preview companion assets", () => {
    expect(isObjPreviewCompanionPath("onshape-sync/bundle/a.mtl")).toBe(true);
    expect(isObjPreviewCompanionPath("onshape-sync/bundle/diffuse.png")).toBe(true);
    expect(isObjPreviewCompanionPath("onshape-sync/bundle/mesh.obj")).toBe(false);
    expect(isObjPreviewCompanionPath("onshape-sync/bundle/model.step")).toBe(false);
  });

  it("parses mtllib lines from OBJ headers", () => {
    expect(parseObjMtllibFilenames("mtllib a.mtl b.mtl\n")).toEqual(["a.mtl", "b.mtl"]);
    expect(parseObjMtllibFilenames("  mtllib   foo.mtl  \n")).toEqual(["foo.mtl"]);
  });

  it("parses texture filenames from MTL map directives", () => {
    expect(parseMtlReferencedAssetFilenames("map_Kd -blendu on -blendv on wood.png\n")).toEqual([
      "wood.png",
    ]);
    expect(parseMtlReferencedAssetFilenames("  map_Kd   -s 1 1 1  tex/foo.JPEG  \r\n")).toEqual([
      "tex/foo.JPEG",
    ]);
    expect(parseMtlReferencedAssetFilenames("newmtl m\ncolor 1 0 0\n")).toEqual([]);
  });
});
