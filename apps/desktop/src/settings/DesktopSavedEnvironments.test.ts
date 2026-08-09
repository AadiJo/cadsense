import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect } from "vitest";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "./DesktopSavedEnvironments.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const safeStorageLayer = Layer.succeed(
  ElectronSafeStorage.ElectronSafeStorage,
  ElectronSafeStorage.ElectronSafeStorage.of({
    isEncryptionAvailable: Effect.succeed(true),
    encryptString: (value) =>
      Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow), Effect.as(encoder.encode(value))),
    decryptString: (value) => Effect.succeed(decoder.decode(value)),
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

const makeRecord = (id: string): PersistedSavedEnvironmentRecord => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  httpBaseUrl: `https://${id}.example.com`,
  wsBaseUrl: `wss://${id}.example.com`,
  createdAt: "2026-08-09T00:00:00.000Z",
  lastConnectedAt: null,
});

describe("DesktopSavedEnvironments", () => {
  it.effect("serializes concurrent secret updates", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "cadsense-desktop-saved-environments-test-",
      });

      yield* Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([makeRecord("alpha"), makeRecord("beta")]);

        yield* Effect.all(
          [
            savedEnvironments.setSecret({ environmentId: "alpha", secret: "secret-alpha" }),
            savedEnvironments.setSecret({ environmentId: "beta", secret: "secret-beta" }),
          ],
          { concurrency: "unbounded" },
        );

        expect(Option.getOrNull(yield* savedEnvironments.getSecret("alpha"))).toBe("secret-alpha");
        expect(Option.getOrNull(yield* savedEnvironments.getSecret("beta"))).toBe("secret-beta");
      }).pipe(Effect.provide(makeLayer(baseDir)));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
