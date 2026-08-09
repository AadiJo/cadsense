import { DEFAULT_CLIENT_SETTINGS, DEFAULT_SERVER_SETTINGS } from "@cadsense/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applySettingsUpdated: vi.fn(),
  getClientSettings: vi.fn(),
  getServerConfig: vi.fn(),
  setClientSettings: vi.fn(),
  updateServerSettings: vi.fn(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: mocks.getClientSettings,
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
  mocks.getClientSettings.mockResolvedValue(null);
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

  it("serializes client writes so the newest settings persist last", async () => {
    const finishes: Array<() => void> = [];
    mocks.setClientSettings.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishes.push(resolve);
        }),
    );

    const first = updateSettingsAndWait({ timestampFormat: "12-hour" });
    const second = updateSettingsAndWait({ timestampFormat: "24-hour" });
    await vi.waitFor(() => expect(mocks.setClientSettings).toHaveBeenCalledTimes(1));

    finishes[0]?.();
    await first;
    await vi.waitFor(() => expect(mocks.setClientSettings).toHaveBeenCalledTimes(2));
    finishes[1]?.();
    await second;

    expect(
      mocks.setClientSettings.mock.calls.map(([settings]) => settings.timestampFormat),
    ).toEqual(["12-hour", "24-hour"]);
  });

  it("rolls back to the last persisted settings when concurrent writes fail", async () => {
    const previousSettings = getClientSettings();
    mocks.setClientSettings.mockRejectedValue(new Error("storage unavailable"));

    const results = await Promise.allSettled([
      updateSettingsAndWait({ timestampFormat: "12-hour" }),
      updateSettingsAndWait({ timestampFormat: "24-hour" }),
    ]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(getClientSettings()).toBe(previousSettings);
  });

  it("does not carry a failed patch into a later successful write", async () => {
    mocks.setClientSettings
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce(undefined);

    const failedWrite = updateSettingsAndWait({ timestampFormat: "12-hour" });
    const successfulWrite = updateSettingsAndWait({ confirmThreadDelete: false });

    await expect(failedWrite).rejects.toThrow("storage unavailable");
    await successfulWrite;

    expect(mocks.setClientSettings).toHaveBeenCalledTimes(2);
    expect(mocks.setClientSettings.mock.calls[1]?.[0]).toMatchObject({
      timestampFormat: DEFAULT_CLIENT_SETTINGS.timestampFormat,
      confirmThreadDelete: false,
    });
    expect(getClientSettings()).toMatchObject({
      timestampFormat: DEFAULT_CLIENT_SETTINGS.timestampFormat,
      confirmThreadDelete: false,
    });
  });

  it("rebases a write on settings that finish hydrating first", async () => {
    let finishHydration: ((settings: { timestampFormat: "12-hour" }) => void) | undefined;
    mocks.getClientSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        finishHydration = resolve;
      }),
    );

    const write = updateSettingsAndWait({ confirmThreadDelete: false });
    await vi.waitFor(() => expect(mocks.getClientSettings).toHaveBeenCalledTimes(1));
    expect(mocks.setClientSettings).not.toHaveBeenCalled();

    finishHydration?.({ timestampFormat: "12-hour" });
    await write;

    expect(mocks.setClientSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        timestampFormat: "12-hour",
        confirmThreadDelete: false,
      }),
    );
    expect(getClientSettings()).toMatchObject({
      timestampFormat: "12-hour",
      confirmThreadDelete: false,
    });
  });
});
