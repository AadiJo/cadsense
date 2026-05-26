import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PlatformError from "effect/PlatformError";
import * as Random from "effect/Random";

const ATOMIC_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200] as const;

const isErrnoExceptionWithCode = (cause: unknown): cause is { readonly code: string } =>
  Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code);

const isTransientRenameError = (error: PlatformError.PlatformError): boolean => {
  if (error.reason._tag !== "Unknown" || error.reason.method !== "rename") {
    return false;
  }

  const cause = error.cause;
  return isErrnoExceptionWithCode(cause) && (cause.code === "EPERM" || cause.code === "EACCES");
};

const renameWithTransientRetries = (
  fs: FileSystem.FileSystem,
  sourcePath: string,
  targetPath: string,
  retryIndex = 0,
): Effect.Effect<void, PlatformError.PlatformError> =>
  fs.rename(sourcePath, targetPath).pipe(
    Effect.catch((error) => {
      const delayMs = ATOMIC_RENAME_RETRY_DELAYS_MS[retryIndex];
      if (delayMs === undefined || !isTransientRenameError(error)) {
        return Effect.fail(error);
      }
      return Effect.sleep(`${delayMs} millis`).pipe(
        Effect.flatMap(() =>
          renameWithTransientRetries(fs, sourcePath, targetPath, retryIndex + 1),
        ),
      );
    }),
  );

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempFileId = yield* Random.nextUUIDv4;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, `${tempFileId}.tmp`);

      yield* fs.writeFileString(tempPath, input.contents);
      yield* renameWithTransientRetries(fs, tempPath, input.filePath);
    }),
  );
