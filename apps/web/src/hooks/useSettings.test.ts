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

  it("rolls concurrent server failures back to the confirmed snapshot", async () => {
    mocks.getServerConfig.mockReturnValue({ settings: DEFAULT_SERVER_SETTINGS });
    mocks.updateServerSettings.mockRejectedValue(new Error("disk full"));

    const results = await Promise.allSettled([
      updateSettingsAndWait({ enableAssistantStreaming: false }),
      updateSettingsAndWait({ enableAssistantStreaming: true }),
    ]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(mocks.applySettingsUpdated).toHaveBeenLastCalledWith(DEFAULT_SERVER_SETTINGS);
  });

  it("rebases a queued server write after an earlier write fails", async () => {
    mocks.getServerConfig.mockReturnValue({ settings: DEFAULT_SERVER_SETTINGS });
    mocks.updateServerSettings.mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce({
      ...DEFAULT_SERVER_SETTINGS,
      enableAssistantStreaming: false,
    });

    const failedWrite = updateSettingsAndWait({ providerInstances: {} });
    const successfulWrite = updateSettingsAndWait({ enableAssistantStreaming: false });

    await expect(failedWrite).rejects.toThrow("disk full");
    await successfulWrite;
    expect(mocks.updateServerSettings.mock.calls).toEqual([
      [{ providerInstances: {} }],
      [{ enableAssistantStreaming: false }],
    ]);
    expect(mocks.applySettingsUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({ enableAssistantStreaming: false }),
    );
  });

  it("preserves an external server snapshot when a pending write fails", async () => {
    const initialSettings = DEFAULT_SERVER_SETTINGS;
    const externalSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      enableAssistantStreaming: false,
    };
    mocks.getServerConfig.mockReturnValue({ settings: initialSettings });
    let failWrite: ((error: Error) => void) | undefined;
    mocks.updateServerSettings.mockReturnValueOnce(
      new Promise((_, reject) => {
        failWrite = reject;
      }),
    );

    const write = updateSettingsAndWait({ providerInstances: {} });
    await vi.waitFor(() => expect(mocks.updateServerSettings).toHaveBeenCalledTimes(1));
    mocks.getServerConfig.mockReturnValue({ settings: externalSettings });
    failWrite?.(new Error("disk full"));

    await expect(write).rejects.toThrow("disk full");
    expect(mocks.applySettingsUpdated).toHaveBeenLastCalledWith(externalSettings);
  });

  it("preserves a newer external server snapshot when a pending write succeeds", async () => {
    const initialSettings = DEFAULT_SERVER_SETTINGS;
    const externalSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      enableAssistantStreaming: false,
    };
    const confirmedSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {},
    };
    mocks.getServerConfig.mockReturnValue({ settings: initialSettings });
    let finishWrite: ((settings: typeof confirmedSettings) => void) | undefined;
    mocks.updateServerSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        finishWrite = resolve;
      }),
    );

    const write = updateSettingsAndWait({ providerInstances: {} });
    await vi.waitFor(() => expect(mocks.updateServerSettings).toHaveBeenCalledTimes(1));
    mocks.getServerConfig.mockReturnValue({ settings: externalSettings });
    finishWrite?.(confirmedSettings);

    await write;
    expect(mocks.applySettingsUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enableAssistantStreaming: false,
        providerInstances: {},
      }),
    );
  });

  it("does not overwrite a newer external change to the same server setting", async () => {
    const initialSettings = DEFAULT_SERVER_SETTINGS;
    const externalSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      addProjectBaseDirectory: "/external-projects",
    };
    const confirmedSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      addProjectBaseDirectory: "/local-projects",
    };
    mocks.getServerConfig.mockReturnValue({ settings: initialSettings });
    let finishWrite: ((settings: typeof confirmedSettings) => void) | undefined;
    mocks.updateServerSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        finishWrite = resolve;
      }),
    );

    const write = updateSettingsAndWait({ addProjectBaseDirectory: "/local-projects" });
    await vi.waitFor(() => expect(mocks.updateServerSettings).toHaveBeenCalledTimes(1));
    mocks.getServerConfig.mockReturnValue({ settings: externalSettings });
    finishWrite?.(confirmedSettings);

    await write;
    expect(mocks.applySettingsUpdated).toHaveBeenLastCalledWith(externalSettings);
  });

  it("preserves an external snapshot captured by a later queued server write", async () => {
    const initialSettings = DEFAULT_SERVER_SETTINGS;
    const externalSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      enableAssistantStreaming: false,
    };
    const firstConfirmedSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {},
    };
    const secondConfirmedSettings = {
      ...firstConfirmedSettings,
      addProjectBaseDirectory: "/projects",
    };
    let currentSettings = initialSettings;
    mocks.getServerConfig.mockImplementation(() => ({ settings: currentSettings }));
    mocks.applySettingsUpdated.mockImplementation((settings) => {
      currentSettings = settings;
    });
    let finishFirstWrite: ((settings: typeof firstConfirmedSettings) => void) | undefined;
    let finishSecondWrite: ((settings: typeof secondConfirmedSettings) => void) | undefined;
    mocks.updateServerSettings
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishFirstWrite = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishSecondWrite = resolve;
        }),
      );

    const firstWrite = updateSettingsAndWait({ providerInstances: {} });
    await vi.waitFor(() => expect(mocks.updateServerSettings).toHaveBeenCalledTimes(1));
    currentSettings = externalSettings;
    const secondWrite = updateSettingsAndWait({ addProjectBaseDirectory: "/projects" });

    finishFirstWrite?.(firstConfirmedSettings);
    await firstWrite;
    await vi.waitFor(() => expect(mocks.updateServerSettings).toHaveBeenCalledTimes(2));
    finishSecondWrite?.(secondConfirmedSettings);
    await secondWrite;

    expect(currentSettings).toMatchObject({
      enableAssistantStreaming: false,
      providerInstances: {},
      addProjectBaseDirectory: "/projects",
    });
  });

  it("waits for every persistence target before surfacing a mixed-patch failure", async () => {
    let finishClientWrite: (() => void) | undefined;
    mocks.updateServerSettings.mockRejectedValueOnce(new Error("disk full"));
    mocks.setClientSettings.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishClientWrite = resolve;
      }),
    );

    let settled = false;
    const write = updateSettingsAndWait({
      providerInstances: {},
      timestampFormat: "12-hour",
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(mocks.setClientSettings).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);

    finishClientWrite?.();
    await expect(write).rejects.toThrow("disk full");
    expect(settled).toBe(true);
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
