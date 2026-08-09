import { DEFAULT_SERVER_SETTINGS } from "@cadsense/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = {
  applySettingsUpdated: vi.fn(),
  getServerConfig: vi.fn(() => null),
  setClientSettings: vi.fn(async () => undefined),
  updateServerSettings: vi.fn(async () => DEFAULT_SERVER_SETTINGS),
};

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: vi.fn(async () => null),
      setClientSettings: mocks.setClientSettings,
    },
    server: {
      updateSettings: mocks.updateServerSettings,
    },
  }),
}));

vi.mock("~/rpc/serverState", () => ({
  applySettingsUpdated: mocks.applySettingsUpdated,
  getServerConfig: mocks.getServerConfig,
  useServerSettings: () => DEFAULT_SERVER_SETTINGS,
}));

import {
  __resetClientSettingsPersistenceForTests,
  getClientSettings,
  updateSettingsAndWait,
} from "./useSettings";

afterEach(() => {
  __resetClientSettingsPersistenceForTests();
  vi.clearAllMocks();
  mocks.getServerConfig.mockReturnValue(null);
  mocks.setClientSettings.mockResolvedValue(undefined);
  mocks.updateServerSettings.mockResolvedValue(DEFAULT_SERVER_SETTINGS);
});

describe("updateSettingsAndWait", () => {
  it("does not resolve until server settings have persisted", async () => {
    let finishWrite: ((value: typeof DEFAULT_SERVER_SETTINGS) => void) | undefined;
    mocks.updateServerSettings.mockReturnValue(
      new Promise((resolve) => {
        finishWrite = resolve;
      }),
    );

    let settled = false;
    const write = updateSettingsAndWait({ providerInstances: {} }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishWrite?.(DEFAULT_SERVER_SETTINGS);
    await write;
    expect(settled).toBe(true);
  });

  it("surfaces server persistence failures", async () => {
    mocks.updateServerSettings.mockRejectedValueOnce(new Error("disk full"));

    await expect(updateSettingsAndWait({ providerInstances: {} })).rejects.toThrow("disk full");
  });

  it("rolls back client settings when persistence fails", async () => {
    const previousSettings = getClientSettings();
    mocks.setClientSettings.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(updateSettingsAndWait({ timestampFormat: "12-hour" })).rejects.toThrow(
      "storage unavailable",
    );
    expect(getClientSettings()).toBe(previousSettings);
  });
});
