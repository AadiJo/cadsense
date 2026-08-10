import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
} from "@cadsense/contracts";
import { createModelSelection } from "@cadsense/shared/model";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  SecretStoreError,
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "./auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "./config.ts";
import {
  commitSettingsUpdateUninterruptibly,
  runBestEffortRollbackSteps,
  ServerSettingsBase,
  ServerSettingsLive,
  ServerSettingsService,
} from "./serverSettings.ts";

const makeServerSettingsLayer = () =>
  ServerSettingsLive.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "cadsense-server-settings-test-",
        }),
      ),
    ),
  );

const makeServerSettingsLayerWithSecretStore = (secretStore: ServerSecretStoreShape) =>
  ServerSettingsBase.pipe(
    Layer.provide(Layer.succeed(ServerSecretStore, secretStore)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "cadsense-server-settings-fault-test-",
        }),
      ),
    ),
  );

it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("synchronizes committed settings before honoring interruption", () =>
    Effect.gen(function* () {
      const persisted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const synchronized = yield* Ref.make(false);
      const fiber = yield* commitSettingsUpdateUninterruptibly(
        Deferred.succeed(persisted, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as("committed"),
        ),
        () => Ref.set(synchronized, true),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(persisted);
      yield* Fiber.interrupt(fiber).pipe(Effect.forkDetach);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(fiber);

      assert.isTrue(yield* Ref.get(synchronized));
    }),
  );

  it.effect("attempts every rollback step after an earlier restoration fails", () =>
    Effect.gen(function* () {
      const attempted = yield* Ref.make<string[]>([]);
      const failures = yield* Ref.make<string[]>([]);
      const step = (name: string, shouldFail = false) =>
        Ref.update(attempted, (current) => [...current, name]).pipe(
          Effect.andThen(shouldFail ? Effect.fail(name) : Effect.void),
        );

      yield* runBestEffortRollbackSteps(
        [step("first-secret", true), step("second-secret"), step("settings")],
        (error) => Ref.update(failures, (current) => [...current, error]),
      );

      assert.deepEqual(yield* Ref.get(attempted), ["first-secret", "second-secret", "settings"]);
      assert.deepEqual(yield* Ref.get(failures), ["first-secret"]);
    }),
  );

  it.effect("decodes nested settings patches", () =>
    Effect.sync(() => {
      const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

      assert.deepEqual(decodePatch({ providers: { codex: { binaryPath: "/tmp/codex" } } }), {
        providers: { codex: { binaryPath: "/tmp/codex" } },
      });

      assert.deepEqual(
        decodePatch({
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        }),
        {
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        },
      );
    }),
  );

  it.effect(
    "decodes legacy object-shaped textGenerationModelSelection.options from settings.json",
    () =>
      Effect.sync(() => {
        const decode = Schema.decodeUnknownSync(ServerSettings);

        const decoded = decode({
          textGenerationModelSelection: {
            provider: ProviderDriverKind.make("codex"),
            model: "gpt-5.4-mini",
            options: { reasoningEffort: "low" },
          },
        });

        assert.deepEqual(decoded.textGenerationModelSelection, {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
          options: [{ id: "reasoningEffort", value: "low" }],
        });
      }),
  );

  it.effect("deep merges nested settings updates without dropping siblings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/usr/local/bin/codex",
            homePath: "/Users/julius/.codex",
          },
          claudeAgent: {
            binaryPath: "/usr/local/bin/claude",
            customModels: ["claude-custom"],
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make("codex"),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "/Users/julius/.codex",
        shadowHomePath: "",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/usr/local/bin/claude",
        homePath: "",
        customModels: ["claude-custom"],
        launchArgs: "",
      });
      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(
          ProviderInstanceId.make("codex"),
          DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: false },
          ],
        ),
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves model when switching providers via textGenerationModelSelection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      // Start with Claude text generation selection
      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
          options: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-sonnet-4-6",
            [{ id: "effort", value: "high" }],
          ).options!,
        },
      });

      // Switch to Codex — the stale Claude "effort" in options must not
      // cause the update to lose the selected model.
      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "reasoningEffort", value: "high" },
          ]).options!,
        },
      });

      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
          { id: "reasoningEffort", value: "high" },
        ]),
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves custom provider instance text generation selections", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("claude_openrouter")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: { customModels: ["openai/gpt-5.5"] },
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claude_openrouter"),
          model: "openai/gpt-5.5",
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "uses explicit provider instance enabled state over legacy provider enabled state",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsService;
        const instanceId = ProviderInstanceId.make("claude_openrouter");

        const next = yield* serverSettings.updateSettings({
          providers: {
            claudeAgent: {
              enabled: false,
            },
          },
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: { customModels: ["openai/gpt-5.5"] },
            },
          },
          textGenerationModelSelection: {
            instanceId,
            model: "openai/gpt-5.5",
          },
        });

        assert.deepEqual(next.textGenerationModelSelection, {
          instanceId,
          model: "openai/gpt-5.5",
        });
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves enabled text generation selections for non-built-in drivers", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const instanceId = ProviderInstanceId.make("openrouter_text");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("openrouter"),
            enabled: true,
            config: { customModels: ["openai/gpt-5.5"] },
          },
        },
        textGenerationModelSelection: {
          instanceId,
          model: "openai/gpt-5.5",
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId,
        model: "openai/gpt-5.5",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("drops stale text generation options when resetting model selection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make("codex"),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("replaces provider instance maps when clearing optional fields", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const codexId = ProviderInstanceId.make("codex");

      yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            accentColor: "#7c3aed",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      assert.deepEqual(next.providerInstances[codexId], {
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex Work",
        enabled: true,
        config: { homePath: "~/.codex" },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("trims provider path settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "  /opt/homebrew/bin/codex  ",
            homePath: "   ",
          },
          claudeAgent: {
            binaryPath: "  /opt/homebrew/bin/claude  ",
          },
          opencode: {
            binaryPath: "  /opt/homebrew/bin/opencode  ",
            serverUrl: "  http://127.0.0.1:4096  ",
            serverPassword: "  secret-password  ",
          },
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "",
        shadowHomePath: "",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/claude",
        homePath: "",
        customModels: [],
        launchArgs: "",
      });
      assert.deepEqual(next.providers.opencode, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/opencode",
        serverUrl: "http://127.0.0.1:4096",
        serverPassword: "secret-password",
        customModels: [],
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("trims observability settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "  ~/Development  ",
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
        },
      });

      assert.equal(next.addProjectBaseDirectory, "~/Development");
      assert.deepEqual(next.observability, {
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("defaults blank binary paths to provider executables", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "   ",
          },
          claudeAgent: {
            binaryPath: "",
          },
        },
      });

      assert.equal(next.providers.codex.binaryPath, "codex");
      assert.equal(next.providers.claudeAgent.binaryPath, "claude");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("writes only non-default server settings to disk", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
          opencode: {
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "secret-password",
          },
        },
        automaticGitFetchInterval: Duration.seconds(10),
      });

      assert.equal(next.providers.codex.binaryPath, "/opt/homebrew/bin/codex");

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(raw), {
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
          opencode: {
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "secret-password",
          },
        },
        automaticGitFetchInterval: 10_000,
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("stores sensitive provider instance environment values outside settings.json", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("codex_personal");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              { name: "OPENROUTER_API_KEY", value: "sk-or-secret", sensitive: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.deepEqual(next.providerInstances[instanceId]?.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "sk-or-secret",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "sk-or-secret");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(raw).providerInstances.codex_personal.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const roundTripped = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Personal",
            environment: [
              { name: "OPENROUTER_API_KEY", value: "", sensitive: true, valueRedacted: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.equal(
        roundTripped.providerInstances[instanceId]?.environment?.[0]?.value,
        "sk-or-secret",
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("migrates inline redacted secrets before unrelated settings updates", () => {
    const values = new Map<string, Uint8Array>();
    const secretStore: ServerSecretStoreShape = {
      get: (name) => Effect.sync(() => values.get(name) ?? null),
      set: (name, value) =>
        Effect.sync(() => {
          values.set(name, Uint8Array.from(value));
        }),
      remove: (name) => Effect.sync(() => values.delete(name)).pipe(Effect.asVoid),
      getOrCreateRandom: () =>
        Effect.fail(new SecretStoreError({ message: "not used in settings test" })),
    };

    return Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("codex_personal");
      const inlineSecret = "externally-managed-secret";

      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        `{
  "providerInstances": {
    "codex_personal": {
      "driver": "codex",
      "environment": [
        {
          "name": "OPENROUTER_API_KEY",
          "value": "${inlineSecret}",
          "sensitive": true,
          "valueRedacted": true
        }
      ],
      "config": {}
    }
  }
}\n`,
      );

      const next = yield* serverSettings.updateSettings({ enableAssistantStreaming: false });

      assert.equal(next.providerInstances[instanceId]?.environment?.[0]?.value, inlineSecret);
      assert.notInclude(yield* fileSystem.readFileString(serverConfig.settingsPath), inlineSecret);
      assert.equal(new TextDecoder().decode(Array.from(values.values())[0]), inlineSecret);
    }).pipe(Effect.provide(makeServerSettingsLayerWithSecretStore(secretStore)));
  });

  it.effect("reconciles externally inlined secrets at startup and later removals", () => {
    const values = new Map<string, Uint8Array>();
    let notifyRemoved: (() => void) | undefined;
    const removed = new Promise<void>((resolve) => {
      notifyRemoved = resolve;
    });
    const secretStore: ServerSecretStoreShape = {
      get: (name) => Effect.sync(() => values.get(name) ?? null),
      set: (name, value) =>
        Effect.sync(() => {
          values.set(name, Uint8Array.from(value));
        }),
      remove: (name) =>
        Effect.sync(() => {
          values.delete(name);
          notifyRemoved?.();
        }),
      getOrCreateRandom: () =>
        Effect.fail(new SecretStoreError({ message: "not used in settings test" })),
    };

    return Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const inlineSecret = "externally-edited-secret";

      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        `{
  "providerInstances": {
    "codex_personal": {
      "driver": "codex",
      "environment": [
        {
          "name": "OPENROUTER_API_KEY",
          "value": "${inlineSecret}",
          "sensitive": true,
          "valueRedacted": true
        }
      ],
      "config": {}
    }
  }
}\n`,
      );

      yield* serverSettings.start;

      assert.equal(new TextDecoder().decode(Array.from(values.values())[0]), inlineSecret);
      assert.notInclude(yield* fileSystem.readFileString(serverConfig.settingsPath), inlineSecret);

      yield* serverSettings.updateSettings({ providerInstances: {} });
      yield* Effect.promise(() => removed);

      assert.equal(values.size, 0);
    }).pipe(Effect.provide(makeServerSettingsLayerWithSecretStore(secretStore)));
  });

  it.effect("does not rewrite malformed settings while reconciling secrets at startup", () => {
    let removeCalls = 0;
    const secretStore: ServerSecretStoreShape = {
      get: () => Effect.succeed(null),
      set: () => Effect.void,
      remove: () =>
        Effect.sync(() => {
          removeCalls += 1;
        }),
      getOrCreateRandom: () =>
        Effect.fail(new SecretStoreError({ message: "not used in settings test" })),
    };

    return Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const malformed = "{ definitely-not-json\n";
      yield* fileSystem.writeFileString(serverConfig.settingsPath, malformed);

      yield* serverSettings.start;

      assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), malformed);
      assert.equal(removeCalls, 0);
    }).pipe(Effect.provide(makeServerSettingsLayerWithSecretStore(secretStore)));
  });

  it.effect("keeps active environment secrets when settings validation fails", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const instanceId = ProviderInstanceId.make("codex_personal");

      yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              { name: "OPENROUTER_API_KEY", value: "sk-active-secret", sensitive: true },
            ],
            config: {},
          },
        },
      });

      const result = yield* serverSettings
        .updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "", value: "", sensitive: false }],
              config: {},
            },
          },
        })
        .pipe(Effect.result);

      assert.isTrue(result._tag === "Failure");
      const current = yield* serverSettings.getSettings;
      assert.equal(
        current.providerInstances[instanceId]?.environment?.[0]?.value,
        "sk-active-secret",
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("rolls back a committed update when secret materialization fails", () => {
    const values = new Map<string, Uint8Array>();
    let getCount = 0;
    const secretStore: ServerSecretStoreShape = {
      get: (name) =>
        Effect.suspend(() => {
          getCount += 1;
          return getCount === 2
            ? Effect.fail(new SecretStoreError({ message: "decrypt failed" }))
            : Effect.succeed(values.get(name) ?? null);
        }),
      set: (name, value) =>
        Effect.sync(() => {
          values.set(name, Uint8Array.from(value));
        }),
      remove: (name) =>
        Effect.sync(() => {
          values.delete(name);
        }),
      getOrCreateRandom: () =>
        Effect.fail(new SecretStoreError({ message: "not used in settings test" })),
    };

    return Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("codex_personal");

      const result = yield* serverSettings
        .updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [
                { name: "OPENROUTER_API_KEY", value: "sk-new-secret", sensitive: true },
              ],
              config: {},
            },
          },
        })
        .pipe(Effect.result);

      assert.isTrue(result._tag === "Failure");
      assert.equal(values.size, 0);
      assert.isUndefined((yield* serverSettings.getSettings).providerInstances[instanceId]);
      assert.isFalse(yield* fileSystem.exists(serverConfig.settingsPath));
    }).pipe(Effect.provide(makeServerSettingsLayerWithSecretStore(secretStore)));
  });

  it.effect("does not expose partially updated secrets through concurrent reads", () =>
    Effect.gen(function* () {
      const values = new Map<string, Uint8Array>();
      const firstNewSecretApplied = yield* Deferred.make<void>();
      const releaseSecretUpdate = yield* Deferred.make<void>();
      const readCompleted = yield* Deferred.make<void>();
      const decoder = new TextDecoder();
      const secretStore: ServerSecretStoreShape = {
        get: (name) => Effect.sync(() => values.get(name) ?? null),
        set: (name, value) =>
          Effect.gen(function* () {
            values.set(name, Uint8Array.from(value));
            if (decoder.decode(value) === "new-a") {
              yield* Deferred.succeed(firstNewSecretApplied, undefined);
              yield* Deferred.await(releaseSecretUpdate);
            }
          }),
        remove: (name) => Effect.sync(() => values.delete(name)).pipe(Effect.asVoid),
        getOrCreateRandom: () =>
          Effect.fail(new SecretStoreError({ message: "not used in settings test" })),
      };

      yield* Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsService;
        const instanceId = ProviderInstanceId.make("codex_personal");
        const instance = (left: string, right: string) => ({
          driver: ProviderDriverKind.make("codex"),
          environment: [
            { name: "SECRET_A", value: left, sensitive: true },
            { name: "SECRET_B", value: right, sensitive: true },
          ],
          config: {},
        });

        yield* serverSettings.updateSettings({
          providerInstances: { [instanceId]: instance("old-a", "old-b") },
        });
        const updateFiber = yield* serverSettings
          .updateSettings({ providerInstances: { [instanceId]: instance("new-a", "new-b") } })
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstNewSecretApplied);

        const readFiber = yield* serverSettings.getSettings.pipe(
          Effect.tap(() => Deferred.succeed(readCompleted, undefined)),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        assert.isTrue(Option.isNone(yield* Deferred.poll(readCompleted)));

        yield* Deferred.succeed(releaseSecretUpdate, undefined);
        yield* Fiber.join(updateFiber);
        const current = yield* Fiber.join(readFiber);
        assert.deepEqual(
          current.providerInstances[instanceId]?.environment?.map((variable) => variable.value),
          ["new-a", "new-b"],
        );
      }).pipe(Effect.provide(makeServerSettingsLayerWithSecretStore(secretStore)));
    }),
  );

  it.effect("emits the materialized secret snapshot committed by each update", () => {
    const values = new Map<string, Uint8Array>();
    const secretStore: ServerSecretStoreShape = {
      get: (name) => Effect.sync(() => values.get(name) ?? null),
      set: (name, value) =>
        Effect.sync(() => {
          values.set(name, Uint8Array.from(value));
        }),
      remove: (name) => Effect.sync(() => values.delete(name)).pipe(Effect.asVoid),
      getOrCreateRandom: () =>
        Effect.fail(new SecretStoreError({ message: "not used in settings test" })),
    };

    return Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const instanceId = ProviderInstanceId.make("codex_personal");
      const updatesFiber = yield* serverSettings.streamChanges.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      const instance = (value: string) => ({
        driver: ProviderDriverKind.make("codex"),
        environment: [{ name: "SECRET", value, sensitive: true }],
        config: {},
      });
      yield* serverSettings.updateSettings({
        providerInstances: { [instanceId]: instance("first-secret") },
      });
      yield* serverSettings.updateSettings({
        providerInstances: { [instanceId]: instance("second-secret") },
      });

      const updates = Array.from(yield* Fiber.join(updatesFiber));
      assert.deepEqual(
        updates.map((settings) => settings.providerInstances[instanceId]?.environment?.[0]?.value),
        ["first-secret", "second-secret"],
      );
    }).pipe(Effect.provide(makeServerSettingsLayerWithSecretStore(secretStore)));
  });

  it.effect("restores the exact settings file when a secret write fails", () => {
    const secretStore: ServerSecretStoreShape = {
      get: () => Effect.succeed(null),
      set: () => Effect.fail(new SecretStoreError({ message: "encrypt failed" })),
      remove: () => Effect.void,
      getOrCreateRandom: () =>
        Effect.fail(new SecretStoreError({ message: "not used in settings test" })),
    };

    return Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("codex_personal");
      const original = `{
  "enableAssistantStreaming": false,
  "futureSetting": { "preserve": true }
}\n`;
      yield* fileSystem.writeFileString(serverConfig.settingsPath, original);

      const result = yield* serverSettings
        .updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "SECRET", value: "new-secret", sensitive: true }],
              config: {},
            },
          },
        })
        .pipe(Effect.result);

      assert.isTrue(result._tag === "Failure");
      assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), original);
    }).pipe(Effect.provide(makeServerSettingsLayerWithSecretStore(secretStore)));
  });
});
