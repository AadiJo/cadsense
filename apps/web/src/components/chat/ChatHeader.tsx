import {
  type EnvironmentId,
  type EditorId,
  type OnshapeContext,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
} from "@cadsense/contracts";
import { memo } from "react";
import { BoxIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { OnshapeSyncControl } from "../OnshapeSyncControl";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../environments/primary";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isProjectlessChat: boolean;
  activeProjectOnshapeContext?: OnshapeContext | null;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  cadPanelOpen: boolean;
  onshapeSyncing: boolean;
  cadExploded: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleCadPanel: (open: boolean) => void;
  onSyncOnshape: () => void;
  onToggleCadExploded: (exploded: boolean) => void;
  onZoomCadToFit: () => void;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly isProjectlessChat?: boolean;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    input.isProjectlessChat !== true &&
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export function shouldShowCadPanelToggle(input: {
  readonly activeProjectName: string | undefined;
  readonly isProjectlessChat?: boolean;
}): boolean {
  return input.isProjectlessChat !== true && Boolean(input.activeProjectName);
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadTitle,
  activeProjectName,
  isProjectlessChat,
  activeProjectOnshapeContext,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  cadPanelOpen,
  onshapeSyncing,
  cadExploded,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleCadPanel,
  onSyncOnshape,
  onToggleCadExploded,
  onZoomCadToFit,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    isProjectlessChat,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  const showCadPanelToggle = shouldShowCadPanelToggle({ activeProjectName, isProjectlessChat });
  const showProjectControls = Boolean(activeProjectName) && !isProjectlessChat;

  return (
    <div className="@container/header-actions flex w-full min-w-0 flex-1 items-center justify-between gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <h2
          className="min-w-0 shrink truncate text-sm font-medium text-foreground"
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
        {showProjectControls && (
          <span
            className="min-w-0 shrink truncate text-xs font-medium text-muted-foreground"
            title={activeProjectName}
          >
            {activeProjectName}
          </span>
        )}
      </div>
      <div className="chat-header-actions ml-auto flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+0.5em)]">
        {showProjectControls && activeProjectOnshapeContext ? (
          <OnshapeSyncControl
            context={activeProjectOnshapeContext}
            isSyncing={onshapeSyncing}
            exploded={cadExploded}
            onSync={onSyncOnshape}
            onToggleExploded={onToggleCadExploded}
            onZoomToFit={onZoomCadToFit}
          />
        ) : showProjectControls && activeProjectScripts ? (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        ) : null}
        {showOpenInPicker && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
            onshapeUrl={activeProjectOnshapeContext?.reference.url ?? null}
          />
        )}
        {showCadPanelToggle ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={cadPanelOpen}
                  onPressedChange={(pressed) => onToggleCadPanel(pressed)}
                  aria-label="Toggle CAD view"
                  variant="outline"
                  size="xs"
                >
                  <BoxIcon className="size-3" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">Toggle CAD view</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
});
