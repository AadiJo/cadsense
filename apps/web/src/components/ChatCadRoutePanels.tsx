import type { CSSProperties } from "react";
import { Suspense, lazy, useCallback } from "react";
import { SidePanelShell, type SidePanelMode } from "./SidePanelShell";
import { RightPanelSheet } from "./RightPanelSheet";
import { Sidebar, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";

const CadPanel = lazy(() => import("./CadPanel"));

const CAD_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_cad_sidebar_width";
const CAD_INLINE_DEFAULT_WIDTH = "clamp(24rem,34vw,36rem)";
const CAD_INLINE_SIDEBAR_MIN_WIDTH = 22 * 16;
const CAD_INLINE_SIDEBAR_MAX_WIDTH = 256 * 16;
const CAD_INLINE_MAIN_CONTENT_MIN_WIDTH = 34 * 16;
const CAD_INLINE_SIDEBAR_MAX_VIEWPORT_FRACTION = 0.42;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;

const CadLoadingFallback = (props: { mode: SidePanelMode }) => {
  return (
    <SidePanelShell mode={props.mode} header={null} showHeader={false}>
      <div
        className="flex min-h-0 flex-1 items-center justify-center bg-card/20 text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
        aria-label="Loading CAD viewer"
      />
    </SidePanelShell>
  );
};

export const LazyCadPanel = (props: { mode: SidePanelMode }) => {
  return (
    <Suspense fallback={<CadLoadingFallback mode={props.mode} />}>
      <CadPanel mode={props.mode} />
    </Suspense>
  );
};

export function CadPanelInlineSidebar(props: {
  open: boolean;
  onClose: () => void;
  onOpen: () => void;
  shouldRender: boolean;
}) {
  const { open, onClose, onOpen, shouldRender } = props;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpen();
        return;
      }
      onClose();
    },
    [onClose, onOpen],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
      if (!composerForm) return true;
      const composerViewport = composerForm.parentElement;
      if (!composerViewport) return true;
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

      const viewportStyle = window.getComputedStyle(composerViewport);
      const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
      const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
      const viewportContentWidth = Math.max(
        0,
        composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
      );
      const formRect = composerForm.getBoundingClientRect();
      const composerFooter = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-footer='true']",
      );
      const composerRightActions = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-actions='right']",
      );
      const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
      const composerFooterGap = composerFooter
        ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
          Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
          0
        : 0;
      const minimumComposerWidth =
        COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
      const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
      const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
      const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
    },
    [],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      className="relative z-30 w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": CAD_INLINE_DEFAULT_WIDTH } as CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="z-30 border-l border-border bg-card text-foreground"
        resizable={{
          getMaxWidth: () =>
            Math.max(
              CAD_INLINE_SIDEBAR_MIN_WIDTH,
              Math.min(
                window.innerWidth * CAD_INLINE_SIDEBAR_MAX_VIEWPORT_FRACTION,
                window.innerWidth - CAD_INLINE_MAIN_CONTENT_MIN_WIDTH,
              ),
            ),
          maxWidth: CAD_INLINE_SIDEBAR_MAX_WIDTH,
          minWidth: CAD_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: CAD_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        {shouldRender ? <LazyCadPanel mode="sidebar" /> : null}
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
}

export function ChatCadSheetPanel(props: {
  open: boolean;
  onClose: () => void;
  shouldRender: boolean;
}) {
  const { open, onClose, shouldRender } = props;
  return (
    <RightPanelSheet open={open} onClose={onClose}>
      {shouldRender ? <LazyCadPanel mode="sheet" /> : null}
    </RightPanelSheet>
  );
}
