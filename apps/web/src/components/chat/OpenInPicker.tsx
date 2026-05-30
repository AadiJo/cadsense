import { EditorId, type ResolvedKeybindingsConfig } from "@cadsense/contracts";
import { memo, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import { usePreferredEditor } from "../../editorPreferences";
import { ChevronDownIcon, FolderClosedIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { readLocalApi } from "~/localApi";

type OptionIcon = React.FC<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

const WpilibIcon: OptionIcon = ({ className, ...props }) => (
  <img {...props} src="/wpilib.svg" alt="" className={className} />
);

const resolveOptions = (platform: string, availableEditors: ReadonlyArray<EditorId>) => {
  const baseOptions: ReadonlyArray<{
    label: string;
    Icon: OptionIcon;
    value: EditorId;
  }> = [
    {
      label: "WPILib VS Code",
      Icon: WpilibIcon,
      value: "wpilib-vscode",
    },
    {
      label: isMacPlatform(platform)
        ? "Finder"
        : isWindowsPlatform(platform)
          ? "Explorer"
          : "Files",
      Icon: FolderClosedIcon,
      value: "file-manager",
    },
  ];
  return baseOptions.filter((option) => availableEditors.includes(option.value));
};

function renderOptionIcon(IconComponent: OptionIcon, className: string): ReactNode {
  return <IconComponent aria-hidden="true" className={className} />;
}

export const OpenInPicker = memo(function OpenInPicker({
  keybindings,
  availableEditors,
  openInCwd,
  onshapeUrl,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  onshapeUrl?: string | null;
}) {
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const options = useMemo(
    () => resolveOptions(navigator.platform, availableEditors),
    [availableEditors],
  );
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;
  const primaryOpenDisabled = onshapeUrl ? false : !preferredEditor || !openInCwd;

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      const api = readLocalApi();
      if (!api || !openInCwd) return;
      const editor = editorId ?? preferredEditor;
      if (!editor) return;
      void api.shell.openInEditor(openInCwd, editor);
      setPreferredEditor(editor);
    },
    [preferredEditor, openInCwd, setPreferredEditor],
  );

  const openInOnshape = useCallback(() => {
    if (!onshapeUrl) return;
    const api = readLocalApi();
    if (api) {
      void api.shell.openExternal(onshapeUrl);
      return;
    }
    window.open(onshapeUrl, "_blank", "noopener,noreferrer");
  }, [onshapeUrl]);

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const api = readLocalApi();
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;

      if (onshapeUrl) {
        e.preventDefault();
        openInOnshape();
        return;
      }

      if (!api || !openInCwd) return;
      if (!preferredEditor) return;

      e.preventDefault();
      void api.shell.openInEditor(openInCwd, preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [preferredEditor, keybindings, openInCwd, onshapeUrl, openInOnshape]);

  return (
    <Group
      aria-label="Open options"
      className="motion-safe:transition-transform motion-safe:duration-180 motion-safe:ease-[var(--motion-ease-out)] motion-safe:has-[button:not(:disabled):hover]:-translate-y-px motion-safe:has-[button:not(:disabled):active]:translate-y-0 motion-safe:has-[button:not(:disabled):active]:scale-[0.985] [&_[data-slot=button]]:hover:!translate-y-0 [&_[data-slot=button]]:active:!scale-100"
    >
      <Button
        size="xs"
        variant="outline"
        disabled={primaryOpenDisabled}
        onClick={() => {
          if (onshapeUrl) {
            openInOnshape();
            return;
          }
          openInEditor(preferredEditor);
        }}
      >
        {onshapeUrl ? (
          <img src="/onshape.svg" alt="" className="size-3.5 rounded-sm object-contain" />
        ) : (
          primaryOption?.Icon &&
          renderOptionIcon(primaryOption.Icon, "size-3.5 rounded-sm object-contain")
        )}
        <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
          Open
        </span>
      </Button>
      <GroupSeparator className="hidden @3xl/header-actions:block" />
      <Menu>
        <MenuTrigger render={<Button aria-label="Copy options" size="icon-xs" variant="outline" />}>
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {onshapeUrl && (
            <MenuItem onClick={openInOnshape}>
              <img src="/onshape.svg" alt="" className="size-4 rounded-sm object-contain" />
              Onshape
              {openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          )}
          {options.length === 0 && <MenuItem disabled>No installed editors found</MenuItem>}
          {options.map(({ label, Icon, value }) => (
            <MenuItem key={value} onClick={() => openInEditor(value)}>
              {renderOptionIcon(Icon, "size-4 rounded-sm object-contain text-muted-foreground")}
              {label}
              {!onshapeUrl && value === preferredEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </Group>
  );
});
