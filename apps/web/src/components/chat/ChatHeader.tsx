import {
  type EnvironmentId,
  type EditorId,
  type OnshapeContext,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@cadsense/contracts";
import { scopeThreadRef } from "@cadsense/client-runtime";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { BoxIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { OnshapeSyncControl } from "../OnshapeSyncControl";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../environments/primary";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isProjectlessChat: boolean;
  activeProjectOnshapeContext?: OnshapeContext | null;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  diffToggleShortcutLabel: string | null;
  gitCwd: string | null;
  diffOpen: boolean;
  onshapeSyncing: boolean;
  cadExploded: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleDiff: () => void;
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
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  isProjectlessChat,
  activeProjectOnshapeContext,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  diffToggleShortcutLabel,
  gitCwd,
  diffOpen,
  onshapeSyncing,
  cadExploded,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleDiff,
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
          <Badge variant="outline" className="min-w-0 shrink overflow-hidden">
            <span className="min-w-0 truncate">{activeProjectName}</span>
          </Badge>
        )}
        {showProjectControls && !isGitRepo && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
      </div>
      <div
        className={`ml-auto flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3 ${
          diffOpen ? "" : "wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+0.5em)]"
        }`}
      >
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
        {showProjectControls && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
          />
        )}
        {showCadPanelToggle ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={diffOpen}
                  onPressedChange={onToggleDiff}
                  aria-label="Toggle CAD view"
                  variant="outline"
                  size="xs"
                >
                  <BoxIcon className="size-3" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">
              {diffToggleShortcutLabel
                ? `Toggle CAD view (${diffToggleShortcutLabel})`
                : "Toggle CAD view"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
});
