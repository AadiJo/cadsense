import type { EnvironmentId, ProjectId } from "@cadsense/contracts";

import { useStore } from "./store";

export async function waitForProjectedProject(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 2_000;
  const hasProject = (): boolean => {
    const environment = useStore.getState().environmentStateById[input.environmentId];
    return environment?.projectById[input.projectId] !== undefined;
  };
  if (hasProject()) {
    return;
  }

  const subscription = { stop: () => {} };
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(() => {
      subscription.stop();
      resolve();
    }, timeoutMs);
    subscription.stop = useStore.subscribe(() => {
      if (!hasProject()) {
        return;
      }
      window.clearTimeout(timeout);
      subscription.stop();
      resolve();
    });
  });
}
