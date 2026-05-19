export interface CadViewerResizeCoordinator {
  readonly schedule: () => void;
  readonly cancel: () => void;
}

/**
 * Coalesces rapid ResizeObserver / layout callbacks into at most one resize per animation frame.
 */
export function createCadViewerResizeCoordinator(resize: () => void): CadViewerResizeCoordinator {
  let rafId = 0;
  return {
    schedule() {
      if (rafId !== 0) {
        return;
      }
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        resize();
      });
    },
    cancel() {
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    },
  };
}
