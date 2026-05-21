import {
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
import { ServerSettingsService } from "../serverSettings.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const DEFAULT_CODEX_INSTANCE_ID = defaultInstanceIdForDriver(CODEX_DRIVER);
const CAD_VIEW_EXPORT_DIRECTORY = "cadsense-cad-screenshots";
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

export class CadViewExportRootError extends Data.TaggedError("CadViewExportRootError")<{
  readonly message: string;
}> {}

function resolveCodexSettingsSource(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): unknown | undefined {
  const instanceConfig = settings.providerInstances[instanceId];
  if (instanceConfig !== undefined) {
    return instanceConfig.driver === CODEX_DRIVER ? (instanceConfig.config ?? {}) : undefined;
  }
  if (instanceId === DEFAULT_CODEX_INSTANCE_ID) {
    return settings.providers.codex;
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
    const configSource = resolveCodexSettingsSource(settings, instanceId);
    if (configSource === undefined) {
      return yield* new CadViewExportRootError({
        message: `Provider instance '${instanceId}' does not expose a Codex CAD screenshot export root.`,
      });
    }
    const codexSettings = yield* decodeCodexSettings(configSource).pipe(
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
