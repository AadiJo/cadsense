import { memo, type ReactNode } from "react";
import { EllipsisIcon, ListTodoIcon, ShieldIcon } from "lucide-react";
import type { RuntimeMode } from "@cadsense/contracts";
import type { ComposerSubmitMode } from "../../composerDraftStore";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  interactionMode?: unknown;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  runtimeMode?: unknown;
  submitMode?: ComposerSubmitMode;
  canGenerateCadReview?: boolean;
  showSubmitModeToggle?: boolean;
  showRuntimeModeControl?: boolean;
  showInteractionModeToggle?: unknown;
  traitsMenuContent?: ReactNode;
  onToggleInteractionMode?: () => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange?: (mode: RuntimeMode) => void;
  onSubmitModeChange?: (mode: ComposerSubmitMode) => void;
}) {
  if (
    !props.traitsMenuContent &&
    !props.activePlan &&
    !props.showRuntimeModeControl &&
    !props.showSubmitModeToggle
  ) {
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
        {props.showSubmitModeToggle ? (
          <>
            <MenuCheckboxItem
              checked={props.submitMode === "ask"}
              onClick={() => props.onSubmitModeChange?.("ask")}
              aria-checked={props.submitMode === "ask"}
            >
              Prompt
            </MenuCheckboxItem>
            {props.canGenerateCadReview ? (
              <MenuCheckboxItem
                checked={props.submitMode === "review"}
                onClick={() => props.onSubmitModeChange?.("review")}
                aria-checked={props.submitMode === "review"}
              >
                Review
              </MenuCheckboxItem>
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <MenuCheckboxItem
                      checked={props.submitMode === "review"}
                      disabled
                      className="data-disabled:pointer-events-auto data-disabled:cursor-not-allowed"
                    />
                  }
                >
                  Review
                </TooltipTrigger>
                <TooltipPopup side="right" className="max-w-56 whitespace-normal">
                  Select a CAD file before starting a review.
                </TooltipPopup>
              </Tooltip>
            )}
            {props.traitsMenuContent || props.showRuntimeModeControl || props.activePlan ? (
              <MenuDivider />
            ) : null}
          </>
        ) : null}
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
