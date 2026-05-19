const CAD_MODEL_EXTENSIONS = [
  "3dm",
  "3ds",
  "3mf",
  "amf",
  "bim",
  "brep",
  "dae",
  "fbx",
  "fcstd",
  "gltf",
  "glb",
  "ifc",
  "iges",
  "igs",
  // Texture maps referenced from MTL (Online3DViewer loads these when URLs are provided).
  "png",
  "jpg",
  "jpeg",
  "tif",
  "tiff",
  "tga",
  "bmp",
  "dds",
  "webp",
  "hdr",
  "exr",
  "mtl",
  "step",
  "stp",
  "stl",
  "obj",
  "off",
  "ply",
  "wrl",
] as const;

const CAD_MODEL_EXTENSION_SET = new Set<string>(CAD_MODEL_EXTENSIONS);

export const CAD_SYNC_DIRECTORY = "onshape-sync";
/** Bytes of OBJ text scanned for `mtllib` (library lines may follow long comment / vertex blocks). */
export const OBJ_MTLLIB_SCAN_MAX_BYTES = 2 * 1024 * 1024;
/** Default Onshape preview artifact (OBJ mesh; faster export than glTF on many assemblies). */
export const DEFAULT_ONSHAPE_SYNC_MODEL_PATH = `${CAD_SYNC_DIRECTORY}/current.obj`;
// STEP default (CAD-accurate, slower previews): `${CAD_SYNC_DIRECTORY}/current.step`;
export const SUPPORTED_CAD_MODEL_EXTENSIONS: readonly string[] = CAD_MODEL_EXTENSIONS;

export function getCadModelExtension(path: string): string | null {
  const normalized = path.trim().toLowerCase();
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot < 0 || lastDot === normalized.length - 1) {
    return null;
  }
  return normalized.slice(lastDot + 1);
}

const OBJ_PREVIEW_COMPANION_EXTENSIONS = new Set([
  "mtl",
  "png",
  "jpg",
  "jpeg",
  "tif",
  "tiff",
  "tga",
  "bmp",
  "dds",
  "webp",
  "hdr",
  "exr",
]);

/** Extra files beside the OBJ that the preview may need (MTL + textures); never other mesh formats. */
export function isObjPreviewCompanionPath(path: string): boolean {
  const ext = getCadModelExtension(path);
  return ext !== null && OBJ_PREVIEW_COMPANION_EXTENSIONS.has(ext);
}

export function isSupportedCadModelPath(path: string): boolean {
  const extension = getCadModelExtension(path);
  return extension !== null && CAD_MODEL_EXTENSION_SET.has(extension);
}

export function isOnshapeSyncRelativePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  return normalized === CAD_SYNC_DIRECTORY || normalized.startsWith(`${CAD_SYNC_DIRECTORY}/`);
}

/**
 * Parses `mtllib` directives from the head of an OBJ file (Online 3D Viewer loads materials when
 * these companion files are reachable).
 */
export function parseObjMtllibFilenames(objSource: string): string[] {
  const names: string[] = [];
  const pattern = /^\s*mtllib\s+(.+)$/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(objSource)) !== null) {
    const payload = match[1]?.trim();
    if (!payload) {
      continue;
    }
    for (const token of payload.split(/\s+/u)) {
      if (token.length === 0) continue;
      names.push(token);
    }
  }
  return names;
}

/**
 * Texture / image paths referenced from an MTL file (`map_Kd`, `map_bump`, etc.).
 * Parsed leniently so flags like `-blendu on` before the filename still resolve.
 */
export function parseMtlReferencedAssetFilenames(mtlSource: string): string[] {
  const names: string[] = [];
  const textureFilename =
    /([\w.\\/:-]+\.(?:png|jpe?g|tif|tiff|tga|bmp|dds|webp|hdr|exr))(?:\s|$)/iu;

  for (const rawLine of mtlSource.split(/\r?\n/u)) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    if (line.length === 0) {
      continue;
    }
    if (!/^(map_\w+|bump|disp|decal|norm|refl)\s+/iu.test(line)) {
      continue;
    }

    const payload = line.replace(/^\s*(map_\w+|bump|disp|decal|norm|refl)\s+/iu, "").trim();
    const extMatch = payload.match(textureFilename);
    if (extMatch) {
      names.push(extMatch[1]!.replaceAll("\\", "/"));
      continue;
    }

    const tokens = payload.split(/\s+/u).filter((t) => t.length > 0);
    if (tokens.length === 0) {
      continue;
    }
    const last = tokens[tokens.length - 1]!;
    if (!last.startsWith("-") && (last.includes("/") || last.includes("\\"))) {
      names.push(last.replaceAll("\\", "/"));
    }
  }

  return names;
}
