/**
 * Unified settings hook.
 *
 * Abstracts the split between server-authoritative settings (persisted in
 * `settings.json` on the server, fetched via `server.getConfig`) and
 * client-only settings (persisted in localStorage).
 *
 * Consumers use `useSettings(selector)` to read, and `useUpdateSettings()` to
 * write. The hook transparently routes reads/writes to the correct backing
 * store.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { ServerSettings, type ServerSettingsPatch } from "@cadsense/contracts";
import {
  type ClientSettingsPatch,
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  UnifiedSettings,
} from "@cadsense/contracts/settings";
import { ensureLocalApi } from "~/localApi";
import * as Struct from "effect/Struct";
import { applyServerSettingsPatch } from "@cadsense/shared/serverSettings";
import { applySettingsUpdated, getServerConfig, useServerSettings } from "~/rpc/serverState";

const CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE = "[CLIENT_SETTINGS]";

const clientSettingsListeners = new Set<() => void>();
const clientSettingsHydrationListeners = new Set<() => void>();
let clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
let persistedClientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
let clientSettingsPersistenceTail = Promise.resolve();
let nextClientSettingsWriteId = 0;
let pendingClientSettingsWrites: Array<{
  id: number;
  patch: ClientSettingsPatch;
}> = [];
let clientSettingsHydrated = false;
let clientSettingsHydrationPromise: Promise<void> | null = null;

function emitClientSettingsChange() {
  for (const listener of clientSettingsListeners) {
    listener();
  }
}

function emitClientSettingsHydrationChange() {
  for (const listener of clientSettingsHydrationListeners) {
    listener();
  }
}

function getClientSettingsSnapshot(): ClientSettings {
  return clientSettingsSnapshot;
}

function replaceClientSettingsSnapshot(settings: ClientSettings): void {
  clientSettingsSnapshot = settings;
  emitClientSettingsChange();
}

function refreshOptimisticClientSettingsSnapshot(): void {
  let settings = persistedClientSettingsSnapshot;
  for (const pendingWrite of pendingClientSettingsWrites) {
    settings = { ...settings, ...pendingWrite.patch };
  }
  replaceClientSettingsSnapshot(settings);
}

function setClientSettingsHydrated(nextHydrated: boolean): void {
  if (clientSettingsHydrated === nextHydrated) {
    return;
  }
  clientSettingsHydrated = nextHydrated;
  emitClientSettingsHydrationChange();
}

function subscribeClientSettings(listener: () => void): () => void {
  clientSettingsListeners.add(listener);
  void hydrateClientSettings();
  return () => {
    clientSettingsListeners.delete(listener);
  };
}

function getClientSettingsHydratedSnapshot(): boolean {
  return clientSettingsHydrated;
}

function subscribeClientSettingsHydration(listener: () => void): () => void {
  clientSettingsHydrationListeners.add(listener);
  void hydrateClientSettings();
  return () => {
    clientSettingsHydrationListeners.delete(listener);
  };
}

async function hydrateClientSettings(): Promise<void> {
  if (clientSettingsHydrated) {
    return;
  }
  if (clientSettingsHydrationPromise) {
    return clientSettingsHydrationPromise;
  }

  const nextHydration = (async () => {
    try {
      const persistedSettings = await ensureLocalApi().persistence.getClientSettings();
      if (persistedSettings) {
        const hydratedSettings = { ...DEFAULT_CLIENT_SETTINGS, ...persistedSettings };
        persistedClientSettingsSnapshot = hydratedSettings;
        refreshOptimisticClientSettingsSnapshot();
      }
    } catch (error) {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} hydrate failed`, error);
    } finally {
      setClientSettingsHydrated(true);
    }
  })();

  const hydrationPromise = nextHydration.finally(() => {
    if (clientSettingsHydrationPromise === hydrationPromise) {
      clientSettingsHydrationPromise = null;
    }
  });
  clientSettingsHydrationPromise = hydrationPromise;

  return clientSettingsHydrationPromise;
}

async function persistClientSettings(patch: ClientSettingsPatch): Promise<void> {
  const pendingWrite = {
    id: nextClientSettingsWriteId++,
    patch,
  };
  pendingClientSettingsWrites.push(pendingWrite);
  refreshOptimisticClientSettingsSnapshot();

  const write = clientSettingsPersistenceTail.then(async () => {
    await hydrateClientSettings();
    const settings = { ...persistedClientSettingsSnapshot, ...patch };
    await ensureLocalApi().persistence.setClientSettings(settings);
    persistedClientSettingsSnapshot = settings;
  });
  clientSettingsPersistenceTail = write.catch(() => undefined);
  try {
    await write;
  } finally {
    pendingClientSettingsWrites = pendingClientSettingsWrites.filter(
      (candidate) => candidate.id !== pendingWrite.id,
    );
    refreshOptimisticClientSettingsSnapshot();
  }
}

// ── Key sets for routing patches ─────────────────────────────────────

const SERVER_SETTINGS_KEYS = new Set<string>(Struct.keys(ServerSettings.fields));

function splitPatch(patch: Partial<UnifiedSettings>): {
  serverPatch: ServerSettingsPatch;
  clientPatch: ClientSettingsPatch;
} {
  const serverPatch: Record<string, unknown> = {};
  const clientPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SERVER_SETTINGS_KEYS.has(key)) {
      serverPatch[key] = value;
    } else {
      clientPatch[key] = value;
    }
  }
  return {
    serverPatch: serverPatch as ServerSettingsPatch,
    clientPatch: clientPatch as ClientSettingsPatch,
  };
}

// ── Hooks ────────────────────────────────────────────────────────────

/**
 * Read merged settings. Selector narrows the subscription so components
 * only re-render when the slice they care about changes.
 */

/**
 * Non-hook accessor for the current merged client settings snapshot.
 * Used by non-React code paths (e.g. runtime services) that need the latest
 * settings without subscribing.
 */
export function getClientSettings(): ClientSettings {
  return getClientSettingsSnapshot();
}

export function useClientSettingsHydrated(): boolean {
  return useSyncExternalStore(
    subscribeClientSettingsHydration,
    getClientSettingsHydratedSnapshot,
    () => false,
  );
}

export function useSettings<T = UnifiedSettings>(selector?: (s: UnifiedSettings) => T): T {
  const serverSettings = useServerSettings();
  const clientSettings = useSyncExternalStore(
    subscribeClientSettings,
    getClientSettingsSnapshot,
    () => DEFAULT_CLIENT_SETTINGS,
  );

  const merged = useMemo<UnifiedSettings>(
    () => ({
      ...serverSettings,
      ...clientSettings,
    }),
    [clientSettings, serverSettings],
  );

  return useMemo(() => (selector ? selector(merged) : (merged as T)), [merged, selector]);
}

export async function updateSettingsAndWait(patch: Partial<UnifiedSettings>): Promise<void> {
  const { serverPatch, clientPatch } = splitPatch(patch);
  const writes: Promise<void>[] = [];

  if (Object.keys(serverPatch).length > 0) {
    const previousServerConfig = getServerConfig();
    const optimisticSettings = previousServerConfig
      ? applyServerSettingsPatch(previousServerConfig.settings, serverPatch)
      : null;
    if (optimisticSettings) {
      applySettingsUpdated(optimisticSettings);
    }
    writes.push(
      ensureLocalApi()
        .server.updateSettings(serverPatch)
        .then(() => undefined)
        .catch((error) => {
          if (optimisticSettings && getServerConfig()?.settings === optimisticSettings) {
            applySettingsUpdated(previousServerConfig!.settings);
          }
          throw error;
        }),
    );
  }

  if (Object.keys(clientPatch).length > 0) {
    writes.push(persistClientSettings(clientPatch));
  }

  await Promise.all(writes);
}

/**
 * Returns an updater that routes each key to the correct backing store.
 *
 * Server keys are optimistically patched in atom-backed server state, then
 * persisted via RPC. Client keys go through client persistence.
 */
export function useUpdateSettings() {
  const updateSettings = useCallback((patch: Partial<UnifiedSettings>): void => {
    void updateSettingsAndWait(patch).catch((error) => {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} persist failed`, error);
    });
  }, []);

  const resetSettings = useCallback(() => {
    updateSettings(DEFAULT_UNIFIED_SETTINGS);
  }, [updateSettings]);

  return {
    updateSettings,
    updateSettingsAndWait,
    resetSettings,
  };
}

export function __resetClientSettingsPersistenceForTests(): void {
  clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
  persistedClientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
  clientSettingsPersistenceTail = Promise.resolve();
  nextClientSettingsWriteId = 0;
  pendingClientSettingsWrites = [];
  clientSettingsHydrated = false;
  clientSettingsHydrationPromise = null;
  clientSettingsListeners.clear();
  clientSettingsHydrationListeners.clear();
}
