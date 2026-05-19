import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { normalizePathForAssert } from "../test/normalizePathForAssert.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const np = normalizePathForAssert;

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/CadSense.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/CadSense.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeEnvironmentLayer = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(env))));

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  Effect.gen(function* () {
    return yield* DesktopEnvironment.DesktopEnvironment;
  }).pipe(Effect.provide(makeEnvironmentLayer(overrides, env)));

describe("DesktopEnvironment", () => {
  it.effect("derives state paths and development identity inside Effect", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          CADSENSE_HOME: " /tmp/cadsense ",
          CADSENSE_COMMIT_HASH: " 0123456789abcdef ",
          CADSENSE_PORT: "4949",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          CADSENSE_DEV_REMOTE_CADSENSE_SERVER_ENTRY_PATH: " /remote/server.mjs ",
          CADSENSE_OTLP_TRACES_URL: " http://127.0.0.1:4318/v1/traces ",
          CADSENSE_OTLP_EXPORT_INTERVAL_MS: "2500",
        },
      );

      assert.equal(environment.isDevelopment, true);
      assert.equal(np(environment.appDataDirectory), "/Users/alice/Library/Application Support");
      assert.equal(np(environment.baseDir), "/tmp/cadsense");
      assert.equal(np(environment.stateDir), "/tmp/cadsense/dev");
      assert.equal(np(environment.desktopSettingsPath), "/tmp/cadsense/dev/desktop-settings.json");
      assert.equal(np(environment.clientSettingsPath), "/tmp/cadsense/dev/client-settings.json");
      assert.equal(
        np(environment.savedEnvironmentRegistryPath),
        "/tmp/cadsense/dev/saved-environments.json",
      );
      assert.equal(np(environment.serverSettingsPath), "/tmp/cadsense/dev/settings.json");
      assert.equal(np(environment.logDir), "/tmp/cadsense/dev/logs");
      assert.equal(np(environment.rootDir), "/repo");
      assert.equal(np(environment.appRoot), "/repo");
      assert.equal(np(environment.backendEntryPath), "/repo/apps/server/dist/bin.mjs");
      assert.equal(np(environment.backendCwd), "/repo");
      assert.equal(environment.appUserModelId, "com.cadsense.cadsense.dev");
      assert.equal(environment.linuxWmClass, "cadsense-dev");
      assert.deepEqual(
        Option.map(environment.devServerUrl, (url) => url.href),
        Option.some("http://localhost:5173/"),
      );
      assert.deepEqual(
        Option.map(environment.devRemoteCadSenseServerEntryPath, np),
        Option.some(np("/remote/server.mjs")),
      );
      assert.deepEqual(environment.configuredBackendPort, Option.some(4949));
      assert.deepEqual(environment.commitHashOverride, Option.some("0123456789abcdef"));
      assert.deepEqual(environment.otlpTracesUrl, Option.some("http://127.0.0.1:4318/v1/traces"));
      assert.equal(environment.otlpExportIntervalMs, 2500);
    }),
  );

  it.effect("derives production state paths under userdata", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          CADSENSE_HOME: "/tmp/cadsense",
        },
      );

      assert.equal(environment.isDevelopment, false);
      assert.equal(np(environment.stateDir), "/tmp/cadsense/userdata");
      assert.equal(np(environment.logDir), "/tmp/cadsense/userdata/logs");
      assert.equal(np(environment.serverSettingsPath), "/tmp/cadsense/userdata/settings.json");
    }),
  );

  it.effect("resolves picker defaults without nullish sentinels", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();

      assert.deepEqual(environment.resolvePickFolderDefaultPath(null), Option.none());
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: " " }),
        Option.none(),
      );
      assert.deepEqual(
        Option.map(environment.resolvePickFolderDefaultPath({ initialPath: "~" }), np),
        Option.some("/Users/alice"),
      );
      assert.deepEqual(
        Option.map(environment.resolvePickFolderDefaultPath({ initialPath: "~/project" }), np),
        Option.some("/Users/alice/project"),
      );
    }),
  );
});
