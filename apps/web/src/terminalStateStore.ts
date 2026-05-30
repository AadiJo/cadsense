import type { ScopedThreadRef } from "@cadsense/contracts";
import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";

interface ThreadTerminalState {
  terminalOpen: boolean;
  terminalHeight: number;
  terminalIds: string[];
  runningTerminalIds: string[];
  activeTerminalId: string;
  terminalGroups: Array<{ id: string; terminalIds: string[] }>;
  activeTerminalGroupId: string;
}

interface TerminalStateStore {
  terminalStateByThreadKey: Record<string, ThreadTerminalState>;
  clearTerminalState: (threadRef: ScopedThreadRef) => void;
  removeTerminalState: (threadRef: ScopedThreadRef) => void;
  removeOrphanedTerminalStates: (activeThreadKeys: ReadonlySet<string>) => void;
  applyTerminalEvent: (threadRef: ScopedThreadRef, event: unknown) => void;
  terminalLaunchContextByThreadKey: Record<string, unknown>;
  terminalEventEntriesByKey: Record<string, unknown>;
  nextTerminalEventId: number;
  clearTerminalLaunchContext: (threadRef: ScopedThreadRef) => void;
}

interface PersistStub {
  clearStorage: () => void;
  rehydrate: () => void;
  hasHydrated: () => boolean;
  onHydrate: () => () => void;
  onFinishHydration: () => () => void;
  getOptions: () => object;
  setOptions: () => void;
}

const EMPTY_THREAD_TERMINAL_STATE: ThreadTerminalState = {
  terminalOpen: false,
  terminalHeight: 280,
  terminalIds: ["default"],
  runningTerminalIds: [],
  activeTerminalId: "default",
  terminalGroups: [{ id: "group-default", terminalIds: ["default"] }],
  activeTerminalGroupId: "group-default",
};

export function selectThreadTerminalState(
  terminalStateByThreadKey: Record<string, ThreadTerminalState>,
  threadRef: ScopedThreadRef | null,
): ThreadTerminalState {
  if (!threadRef) return EMPTY_THREAD_TERMINAL_STATE;
  return (
    terminalStateByThreadKey[`${threadRef.environmentId}:${threadRef.threadId}`] ??
    EMPTY_THREAD_TERMINAL_STATE
  );
}

export const useTerminalStateStore = create<TerminalStateStore>(() => ({
  terminalStateByThreadKey: {},
  terminalLaunchContextByThreadKey: {},
  terminalEventEntriesByKey: {},
  nextTerminalEventId: 0,
  clearTerminalState: () => undefined,
  removeTerminalState: () => undefined,
  removeOrphanedTerminalStates: () => undefined,
  applyTerminalEvent: () => undefined,
  clearTerminalLaunchContext: () => undefined,
})) as UseBoundStore<StoreApi<TerminalStateStore>> & { persist: PersistStub };

Object.assign(useTerminalStateStore, {
  persist: {
    clearStorage: () => undefined,
    rehydrate: () => undefined,
    hasHydrated: () => true,
    onHydrate: () => () => undefined,
    onFinishHydration: () => () => undefined,
    getOptions: () => ({}),
    setOptions: () => undefined,
  },
});
