import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";

import { ProviderInstanceId } from "@cadsense/contracts";

import { ServerSettingsService } from "../serverSettings.ts";
import { resolveCadViewExportRootForInstance } from "./CadViewExportRoot.ts";

const providerInstanceId = (value: string) => ProviderInstanceId.make(value);

describe("CadViewExportRoot", () => {
  it("resolves the Codex screenshot export root for explicit instances", async () => {
    const codexPersonalId = providerInstanceId("codex_personal");
    const result = await Effect.runPromise(
      resolveCadViewExportRootForInstance(codexPersonalId).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            ServerSettingsService.layerTest({
              providerInstances: {
                [codexPersonalId]: {
                  driver: "codex",
                  config: { homePath: "~/cad-codex-home" },
                },
              },
            }),
          ),
        ),
      ),
    );

    expect(result.replaceAll("\\", "/")).toContain("/cad-codex-home/cadsense-cad-screenshots");
  });

  it("falls back to legacy providers.codex settings for the default instance id", async () => {
    const result = await Effect.runPromise(
      resolveCadViewExportRootForInstance(providerInstanceId("codex")).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            ServerSettingsService.layerTest({
              providers: {
                codex: { homePath: "~/legacy-codex-home" },
              },
            }),
          ),
        ),
      ),
    );

    expect(result.replaceAll("\\", "/")).toContain("/legacy-codex-home/cadsense-cad-screenshots");
  });

  it("rejects non-Codex instances", async () => {
    const claudeInstanceId = providerInstanceId("claudeAgent");
    const exit = await Effect.runPromiseExit(
      resolveCadViewExportRootForInstance(claudeInstanceId).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            ServerSettingsService.layerTest({
              providerInstances: {
                [claudeInstanceId]: {
                  driver: "claudeAgent",
                  config: {},
                },
              },
            }),
          ),
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.pretty(exit.cause)).toContain(
        "does not expose a Codex CAD screenshot export root",
      );
    }
  });
});
