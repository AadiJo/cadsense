import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths, WorkspacePathOutsideRootError } from "../Services/WorkspacePaths.ts";

const rejectOutsideRoot = (input: { cwd: string; relativePath: string }) =>
  new WorkspacePathOutsideRootError({
    workspaceRoot: input.cwd,
    relativePath: input.relativePath,
  });

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const isWithinRoot = (root: string, candidate: string): boolean => {
    const relative = path.relative(root, candidate);
    return (
      relative.length === 0 ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  const realPathOrNull = (candidate: string) =>
    fileSystem.realPath(candidate).pipe(Effect.catch(() => Effect.succeed(null)));

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const canonicalRoot = yield* fileSystem.realPath(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.realPathRoot",
            detail: cause.message,
            cause,
          }),
      ),
    );
    const parentPath = path.dirname(target.absolutePath);
    let existingAncestor = parentPath;
    let canonicalAncestor = yield* realPathOrNull(existingAncestor);
    while (canonicalAncestor === null) {
      const nextAncestor = path.dirname(existingAncestor);
      if (nextAncestor === existingAncestor) {
        return yield* rejectOutsideRoot(input);
      }
      existingAncestor = nextAncestor;
      canonicalAncestor = yield* realPathOrNull(existingAncestor);
    }
    if (!isWithinRoot(canonicalRoot, canonicalAncestor)) {
      return yield* rejectOutsideRoot(input);
    }

    yield* fileSystem.makeDirectory(parentPath, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    const canonicalParent = yield* fileSystem.realPath(parentPath).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.realPathParent",
            detail: cause.message,
            cause,
          }),
      ),
    );
    if (!isWithinRoot(canonicalRoot, canonicalParent)) {
      return yield* rejectOutsideRoot(input);
    }
    const existingTarget = yield* realPathOrNull(target.absolutePath);
    if (existingTarget !== null && !isWithinRoot(canonicalRoot, existingTarget)) {
      return yield* rejectOutsideRoot(input);
    }
    const canonicalTarget = path.join(canonicalParent, path.basename(target.absolutePath));
    yield* writeFileStringAtomically({
      filePath: canonicalTarget,
      contents: input.contents,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });
  return { writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
