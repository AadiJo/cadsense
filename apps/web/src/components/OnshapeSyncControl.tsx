import type { OnshapeContext } from "@cadsense/contracts";
import { RefreshCwIcon } from "lucide-react";

import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface OnshapeSyncControlProps {
  readonly context: OnshapeContext;
  readonly isSyncing: boolean;
  readonly onSync: () => void;
}

function statusLabel(context: OnshapeContext, isSyncing: boolean): string {
  if (isSyncing) {
    return "Syncing...";
  }
  if (context.lastSyncError) {
    return "Sync failed";
  }
  if (context.lastSyncedAt) {
    return `Synced ${formatRelativeTimeLabel(context.lastSyncedAt)}`;
  }
  return "Never synced";
}

export function OnshapeSyncControl({ context, isSyncing, onSync }: OnshapeSyncControlProps) {
  const label = statusLabel(context, isSyncing);
  const tooltip = context.lastSyncError
    ? context.lastSyncError
    : context.lastSyncedRelativePath
      ? `Saved to ${context.lastSyncedRelativePath}`
      : "Download the current Onshape model into this workspace";

  return (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="xs" variant="outline" onClick={onSync} disabled={isSyncing}>
              <RefreshCwIcon className={`size-3.5 ${isSyncing ? "animate-spin" : ""}`} />
              <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                Sync
              </span>
            </Button>
          }
        />
        <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
      </Tooltip>
      <span className="hidden max-w-32 truncate text-xs text-muted-foreground @3xl/header-actions:inline">
        {label}
      </span>
    </div>
  );
}
