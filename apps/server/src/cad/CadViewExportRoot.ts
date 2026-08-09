import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  defaultInstanceIdForDriver,
  type ProviderInstanceId,
  type ServerSettings,
} from "@cadsense/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const DEFAULT_CODEX_INSTANCE_ID = defaultInstanceIdForDriver(CODEX_DRIVER);
const DEFAULT_CLAUDE_INSTANCE_ID = defaultInstanceIdForDriver(CLAUDE_DRIVER);
const CAD_VIEW_EXPORT_DIRECTORY = "cadsense-cad-screenshots";
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);

export class CadViewExportRootError extends Data.TaggedError("CadViewExportRootError")<{
  readonly message: string;
}> {}

function resolveProviderSettingsSource(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
):
  | { readonly driver: typeof CODEX_DRIVER | typeof CLAUDE_DRIVER; readonly config: unknown }
  | undefined {
  const instanceConfig = settings.providerInstances[instanceId];
  if (instanceConfig !== undefined) {
    return instanceConfig.driver === CODEX_DRIVER || instanceConfig.driver === CLAUDE_DRIVER
      ? { driver: instanceConfig.driver, config: instanceConfig.config ?? {} }
      : undefined;
  }
  if (instanceId === DEFAULT_CODEX_INSTANCE_ID) {
    return { driver: CODEX_DRIVER, config: settings.providers.codex };
  }
  if (instanceId === DEFAULT_CLAUDE_INSTANCE_ID) {
    return { driver: CLAUDE_DRIVER, config: settings.providers.claudeAgent };
  }
  return undefined;
}

export const resolveCadViewExportRootForInstance = Effect.fn("resolveCadViewExportRootForInstance")(
  function* (
    instanceId: ProviderInstanceId,
  ): Effect.fn.Return<string, CadViewExportRootError, Path.Path | ServerSettingsService> {
    const serverSettings = yield* ServerSettingsService;
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (error) =>
          new CadViewExportRootError({
            message: error.message,
          }),
      ),
    );
    const providerSettings = resolveProviderSettingsSource(settings, instanceId);
    if (providerSettings === undefined) {
      return yield* new CadViewExportRootError({
        message: `Provider instance '${instanceId}' does not expose a CAD screenshot export root.`,
      });
    }
    if (providerSettings.driver === CLAUDE_DRIVER) {
      const claudeSettings = yield* decodeClaudeSettings(providerSettings.config).pipe(
        Effect.mapError(
          (cause) =>
            new CadViewExportRootError({
              message: `Provider instance '${instanceId}' has invalid Claude settings: ${String(cause)}`,
            }),
        ),
      );
      const claudeHomePath = yield* resolveClaudeHomePath(claudeSettings);
      const path = yield* Path.Path;
      return path.join(claudeHomePath, CAD_VIEW_EXPORT_DIRECTORY);
    }
    const codexSettings = yield* decodeCodexSettings(providerSettings.config).pipe(
      Effect.mapError(
        (cause) =>
          new CadViewExportRootError({
            message: `Provider instance '${instanceId}' has invalid Codex settings: ${String(cause)}`,
          }),
      ),
    );
    const homeLayout = yield* resolveCodexHomeLayout(codexSettings);
    const path = yield* Path.Path;
    return path.join(
      homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath,
      CAD_VIEW_EXPORT_DIRECTORY,
    );
  },
);
