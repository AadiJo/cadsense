import { memo, type ReactNode } from "react";
import { EllipsisIcon, ListTodoIcon, ShieldIcon } from "lucide-react";
import type { RuntimeMode } from "@cadsense/contracts";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator as MenuDivider, MenuTrigger } from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  interactionMode?: unknown;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  runtimeMode?: unknown;
  showRuntimeModeControl?: boolean;
  showInteractionModeToggle?: unknown;
  traitsMenuContent?: ReactNode;
  onToggleInteractionMode?: () => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange?: (mode: RuntimeMode) => void;
}) {
  if (!props.traitsMenuContent && !props.activePlan && !props.showRuntimeModeControl) {
    return null;
  }

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showRuntimeModeControl ? (
          <>
            <MenuItem
              onClick={() => props.onRuntimeModeChange?.("approval-required" satisfies RuntimeMode)}
            >
              <ShieldIcon className="size-4 shrink-0" />
              Ask before edits
            </MenuItem>
            <MenuItem
              onClick={() => props.onRuntimeModeChange?.("auto-accept-edits" satisfies RuntimeMode)}
            >
              <ShieldIcon className="size-4 shrink-0" />
              Auto-accept edits
            </MenuItem>
            <MenuItem
              onClick={() => props.onRuntimeModeChange?.("full-access" satisfies RuntimeMode)}
            >
              <ShieldIcon className="size-4 shrink-0" />
              Full access
            </MenuItem>
            <MenuDivider />
          </>
        ) : null}
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen
                ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
                : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
