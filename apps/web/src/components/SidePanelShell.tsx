import type { ReactNode } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";

export type SidePanelMode = "inline" | "sheet" | "sidebar";

function getSidePanelHeaderRowClassName(mode: SidePanelMode) {
  const shouldUseDragRegion = isElectron && mode !== "sheet";
  return cn(
    "flex items-center justify-between gap-2 px-4",
    shouldUseDragRegion
      ? "drag-region h-[60px] border-b border-border wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]"
      : "h-12 wco:max-h-[env(titlebar-area-height)]",
  );
}

export function SidePanelShell(props: {
  mode: SidePanelMode;
  header: ReactNode;
  children: ReactNode;
  /** When false, the header row is hidden; Electron still keeps an empty drag strip when needed. */
  showHeader?: boolean;
}) {
  const shouldUseDragRegion = isElectron && props.mode !== "sheet";
  const showHeader = props.showHeader !== false;

  return (
    <div
      className={cn(
        "flex h-full min-w-0 flex-col bg-background",
        props.mode === "inline"
          ? "w-[42vw] min-w-[360px] max-w-[560px] shrink-0 border-l border-border"
          : "w-full",
      )}
    >
      {shouldUseDragRegion ? (
        <div className={getSidePanelHeaderRowClassName(props.mode)}>
          {showHeader ? props.header : null}
        </div>
      ) : showHeader ? (
        <div className="border-b border-border">
          <div className={getSidePanelHeaderRowClassName(props.mode)}>{props.header}</div>
        </div>
      ) : null}
      {props.children}
    </div>
  );
}
