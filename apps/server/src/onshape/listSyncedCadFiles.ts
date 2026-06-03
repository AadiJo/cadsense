import type { OnshapeListSyncedCadFilesResult, OnshapeSyncedCadFile } from "@cadsense/contracts";
import {
  CAD_SYNC_DIRECTORY,
  DEFAULT_ONSHAPE_SYNC_MODEL_PATH,
  getCadModelExtension,
  isObjPreviewCompanionPath,
  isOnshapeSyncRelativePath,
  isSupportedCadModelPath,
  OBJ_MTLLIB_SCAN_MAX_BYTES,
  parseMtlReferencedAssetFilenames,
  parseObjMtllibFilenames,
} from "@cadsense/shared/cad";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { buildCadModelUrl } from "../cad/cadModelHttpPath.ts";

function normalizeCadRelativePath(relativePath: string): string | null {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    !isOnshapeSyncRelativePath(normalized) ||
    !isSupportedCadModelPath(normalized)
  ) {
    return null;
  }
  return normalized;
}

function isWithinRoot(pathService: Path.Path, root: string, candidate: string): boolean {
  const normalizedRoot = pathService.resolve(root);
  const normalizedCandidate = pathService.resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(
      normalizedRoot.endsWith(pathService.sep)
        ? normalizedRoot
        : `${normalizedRoot}${pathService.sep}`,
    )
  );
}

const BUNDLE_SYNC_RELATIVE_PREFIX = `${CAD_SYNC_DIRECTORY}/bundle`;

function toCadFileSizeBytes(size: bigint | number): number {
  const asBigInt = typeof size === "bigint" ? size : BigInt(Math.max(0, Math.trunc(size)));
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(asBigInt > maxSafe ? maxSafe : asBigInt);
}

function cadFileCacheVersion(stat: {
  readonly size: bigint | number;
  readonly mtime: Option.Option<Date>;
}) {
  return Option.isSome(stat.mtime)
    ? `${stat.size.toString()}-${stat.mtime.value.getTime()}`
    : stat.size.toString();
}

function isBundleObjPreviewPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const ext = getCadModelExtension(normalized);
  return (
    ext === "obj" &&
    (normalized === BUNDLE_SYNC_RELATIVE_PREFIX ||
      normalized.startsWith(`${BUNDLE_SYNC_RELATIVE_PREFIX}/`))
  );
}

const pickLargestObjInBundleEffect = (input: {
  readonly workspaceRoot: string;
  readonly syncRoot: string;
  readonly pathService: Path.Path;
  readonly fileSystem: FileSystem.FileSystem;
}): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const bundleAbs = input.pathService.resolve(
      input.workspaceRoot,
      input.pathService.join(CAD_SYNC_DIRECTORY, "bundle"),
    );
    const entries = yield* input.fileSystem
      .readDirectory(bundleAbs, { recursive: true })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])));
    let best: string | null = null;
    let bestSize = 0n;
    for (const entry of entries) {
      const entrySlash = entry.replaceAll("\\", "/");
      const rel = normalizeCadRelativePath(`${CAD_SYNC_DIRECTORY}/bundle/${entrySlash}`);
      if (rel === null || getCadModelExtension(rel) !== "obj") {
        continue;
      }
      const abs = input.pathService.resolve(input.workspaceRoot, rel);
      if (!isWithinRoot(input.pathService, input.syncRoot, abs)) {
        continue;
      }
      const stat = yield* input.fileSystem.stat(abs).pipe(Effect.catch(() => Effect.succeed(null)));
      if (!stat || stat.type !== "File") {
        continue;
      }
      if (stat.size > bestSize) {
        bestSize = stat.size;
        best = rel;
      }
    }
    return best;
  });

const listObjAndMaterialLibs = (input: {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly syncRoot: string;
  readonly pathService: Path.Path;
  readonly fileSystem: FileSystem.FileSystem;
  readonly objRelativePath: string;
}): Effect.Effect<OnshapeSyncedCadFile[], never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const absoluteObj = input.pathService.resolve(input.workspaceRoot, input.objRelativePath);
    const objStat = yield* input.fileSystem
      .stat(absoluteObj)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const files: OnshapeSyncedCadFile[] = [
      {
        relativePath: input.objRelativePath,
        url:
          objStat?.type === "File"
            ? buildCadModelUrl(input.cwd, input.objRelativePath, cadFileCacheVersion(objStat))
            : buildCadModelUrl(input.cwd, input.objRelativePath),
        isPreferred: true,
        ...(objStat?.type === "File" ? { sizeBytes: toCadFileSizeBytes(objStat.size) } : {}),
      },
    ];
    const objText = yield* input.fileSystem
      .readFileString(absoluteObj)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const seen = new Set(files.map((f) => f.relativePath));
    if (objText !== null) {
      const head =
        objText.length > OBJ_MTLLIB_SCAN_MAX_BYTES
          ? objText.slice(0, OBJ_MTLLIB_SCAN_MAX_BYTES)
          : objText;
      const mtllibs = parseObjMtllibFilenames(head);
      const objDir = input.pathService.dirname(input.objRelativePath);
      for (const mtlName of mtllibs) {
        if (mtlName.includes("\0")) {
          continue;
        }
        const mtlRelJoinedSlash = input.pathService.join(objDir, mtlName).replaceAll("\\", "/");
        const mtlRelative = normalizeCadRelativePath(mtlRelJoinedSlash);
        if (mtlRelative === null || seen.has(mtlRelative)) {
          continue;
        }
        const mtlAbsolute = input.pathService.resolve(input.workspaceRoot, mtlRelative);
        if (!isWithinRoot(input.pathService, input.syncRoot, mtlAbsolute)) {
          continue;
        }
        const mtlStat = yield* input.fileSystem
          .stat(mtlAbsolute)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (mtlStat?.type !== "File") {
          continue;
        }
        seen.add(mtlRelative);
        files.push({
          relativePath: mtlRelative,
          url: buildCadModelUrl(input.cwd, mtlRelative, cadFileCacheVersion(mtlStat)),
          isPreferred: true,
          sizeBytes: toCadFileSizeBytes(mtlStat.size),
        });
      }
    }

    const mtlRelativePaths = files
      .map((f) => f.relativePath)
      .filter((rel) => getCadModelExtension(rel) === "mtl");
    for (const mtlRelativePath of mtlRelativePaths) {
      const mtlAbsolutePath = input.pathService.resolve(input.workspaceRoot, mtlRelativePath);
      const mtlText = yield* input.fileSystem
        .readFileString(mtlAbsolutePath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (mtlText === null) {
        continue;
      }
      const mtlDir = input.pathService.dirname(mtlRelativePath);
      for (const assetName of parseMtlReferencedAssetFilenames(mtlText)) {
        if (assetName.includes("\0")) {
          continue;
        }
        const assetRelJoined = input.pathService.join(mtlDir, assetName).replaceAll("\\", "/");
        const assetRelative = normalizeCadRelativePath(assetRelJoined);
        if (assetRelative === null || seen.has(assetRelative)) {
          continue;
        }
        const assetAbsolute = input.pathService.resolve(input.workspaceRoot, assetRelative);
        if (!isWithinRoot(input.pathService, input.syncRoot, assetAbsolute)) {
          continue;
        }
        const assetStat = yield* input.fileSystem
          .stat(assetAbsolute)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (assetStat?.type !== "File") {
          continue;
        }
        seen.add(assetRelative);
        files.push({
          relativePath: assetRelative,
          url: buildCadModelUrl(input.cwd, assetRelative, cadFileCacheVersion(assetStat)),
          isPreferred: true,
          sizeBytes: toCadFileSizeBytes(assetStat.size),
        });
      }
    }

    const objDirRel = input.pathService.dirname(input.objRelativePath);
    const objDirAbs = input.pathService.resolve(input.workspaceRoot, objDirRel);
    const dirEntries = yield* input.fileSystem
      .readDirectory(objDirAbs)
      .pipe(Effect.catch(() => Effect.succeed([] as string[])));
    for (const name of dirEntries) {
      const childRelJoined = input.pathService.join(objDirRel, name).replaceAll("\\", "/");
      const childRelative = normalizeCadRelativePath(childRelJoined);
      if (
        childRelative === null ||
        !isObjPreviewCompanionPath(childRelative) ||
        seen.has(childRelative)
      ) {
        continue;
      }
      const childAbs = input.pathService.resolve(input.workspaceRoot, childRelative);
      if (!isWithinRoot(input.pathService, input.syncRoot, childAbs)) {
        continue;
      }
      const childStat = yield* input.fileSystem
        .stat(childAbs)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (childStat?.type !== "File") {
        continue;
      }
      seen.add(childRelative);
      files.push({
        relativePath: childRelative,
        url: buildCadModelUrl(input.cwd, childRelative, cadFileCacheVersion(childStat)),
        isPreferred: true,
        sizeBytes: toCadFileSizeBytes(childStat.size),
      });
    }

    return files;
  });

export const listSyncedCadFiles = (input: {
  readonly cwd: string;
  readonly preferredRelativePath?: string;
}): Effect.Effect<OnshapeListSyncedCadFilesResult, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const workspaceRoot = pathService.resolve(input.cwd);
    const syncRoot = pathService.resolve(workspaceRoot, CAD_SYNC_DIRECTORY);
    const preferred = input.preferredRelativePath
      ? normalizeCadRelativePath(input.preferredRelativePath)
      : null;

    if (preferred !== null) {
      let viewerObjPath = preferred;
      if (isBundleObjPreviewPath(preferred)) {
        const largestInBundle = yield* pickLargestObjInBundleEffect({
          workspaceRoot,
          syncRoot,
          pathService,
          fileSystem,
        });
        if (largestInBundle !== null) {
          viewerObjPath = largestInBundle;
        }
      }
      const absolutePath = pathService.resolve(workspaceRoot, viewerObjPath);
      if (isWithinRoot(pathService, syncRoot, absolutePath)) {
        const stat = yield* fileSystem
          .stat(absolutePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (stat?.type === "File" && getCadModelExtension(viewerObjPath) === "obj") {
          const files = yield* listObjAndMaterialLibs({
            cwd: input.cwd,
            workspaceRoot,
            syncRoot,
            pathService,
            fileSystem,
            objRelativePath: viewerObjPath,
          });
          return { files };
        }
        if (stat?.type === "File") {
          return {
            files: [
              {
                relativePath: viewerObjPath,
                url: buildCadModelUrl(input.cwd, viewerObjPath, cadFileCacheVersion(stat)),
                isPreferred: true,
                sizeBytes: toCadFileSizeBytes(stat.size),
              },
            ],
          };
        }
      }
    }

    const candidates = new Set<string>();
    candidates.add(preferred ?? DEFAULT_ONSHAPE_SYNC_MODEL_PATH);

    const entries = yield* fileSystem
      .readDirectory(syncRoot, { recursive: true })
      .pipe(Effect.catch(() => Effect.succeed([])));
    for (const entry of entries) {
      const normalized = normalizeCadRelativePath(`${CAD_SYNC_DIRECTORY}/${entry}`);
      if (normalized) {
        candidates.add(normalized);
      }
    }

    const collected: {
      readonly relativePath: string;
      readonly url: string;
      readonly size: bigint;
    }[] = [];
    for (const relativePath of candidates) {
      const absolutePath = pathService.resolve(workspaceRoot, relativePath);
      if (!isWithinRoot(pathService, syncRoot, absolutePath)) {
        continue;
      }
      const stat = yield* fileSystem
        .stat(absolutePath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!stat || stat.type !== "File") {
        continue;
      }
      collected.push({
        relativePath,
        url: buildCadModelUrl(input.cwd, relativePath, cadFileCacheVersion(stat)),
        size: stat.size,
      });
    }

    const preferredRow =
      preferred !== null ? collected.find((c) => c.relativePath === preferred) : undefined;
    if (preferredRow && getCadModelExtension(preferredRow.relativePath) !== "obj") {
      return {
        files: [
          {
            relativePath: preferredRow.relativePath,
            url: preferredRow.url,
            isPreferred: true,
            sizeBytes: toCadFileSizeBytes(preferredRow.size),
          },
        ],
      };
    }

    const defaultRow = collected.find((c) => c.relativePath === DEFAULT_ONSHAPE_SYNC_MODEL_PATH);
    if (
      preferred === null &&
      defaultRow &&
      getCadModelExtension(defaultRow.relativePath) !== "obj"
    ) {
      return {
        files: [
          {
            relativePath: defaultRow.relativePath,
            url: defaultRow.url,
            isPreferred: true,
            sizeBytes: toCadFileSizeBytes(defaultRow.size),
          },
        ],
      };
    }

    const objRows = collected.filter((c) => getCadModelExtension(c.relativePath) === "obj");
    if (objRows.length > 1) {
      const primary = objRows.reduce((a, b) => (a.size >= b.size ? a : b));
      const files = yield* listObjAndMaterialLibs({
        cwd: input.cwd,
        workspaceRoot,
        syncRoot,
        pathService,
        fileSystem,
        objRelativePath: primary.relativePath,
      });
      return { files };
    }

    return {
      files: collected.map((c) => ({
        relativePath: c.relativePath,
        url: c.url,
        isPreferred: preferred !== null && c.relativePath === preferred,
        sizeBytes: toCadFileSizeBytes(c.size),
      })),
    };
  });
