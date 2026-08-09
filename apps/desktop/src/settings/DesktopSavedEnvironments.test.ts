import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "./DesktopSavedEnvironments.ts";

const safeStorageLayer = Layer.succeed(
  ElectronSafeStorage.ElectronSafeStorage,
  ElectronSafeStorage.ElectronSafeStorage.of({
    isEncryptionAvailable: Effect.succeed(false),
    encryptString: () => Effect.die("not used"),
    decryptString: () => Effect.die("not used"),
  }),
);

function makeLayer(baseDir: string) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ CADSENSE_HOME: baseDir })),
    ),
  );

  return DesktopSavedEnvironments.layer.pipe(
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(safeStorageLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

const withSavedEnvironments = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    R | DesktopSavedEnvironments.DesktopSavedEnvironments | DesktopEnvironment.DesktopEnvironment
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "cadsense-desktop-saved-environments-test-",
    });
    return yield* effect.pipe(Effect.provide(makeLayer(baseDir)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopSavedEnvironments", () => {
  it.effect("uses an empty registry only when the file does not exist", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        expect(yield* savedEnvironments.getRegistry).toEqual([]);
      }),
    ),
  );

  it.effect("does not overwrite a registry that cannot be decoded", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        const corruptDocument = "{ this is not valid json }\n";

        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.savedEnvironmentRegistryPath, corruptDocument);

        const readError = yield* Effect.flip(savedEnvironments.getRegistry);
        expect(readError._tag).toBe("DesktopSavedEnvironmentsReadError");

        const writeError = yield* Effect.flip(savedEnvironments.setRegistry([]));
        expect(writeError._tag).toBe("DesktopSavedEnvironmentsWriteError");
        expect(
          yield* fileSystem.readFileString(environment.savedEnvironmentRegistryPath),
        ).toBe(corruptDocument);
      }),
    ),
  );
});
