/**
 * online-3d-viewer tweens cameras over `settings.animationSteps` frames (~60fps),
 * one requestAnimationFrame per step (see Navigation.MoveCamera).
 */
export function cadViewerOrientationTweenMs(animationSteps: number): number {
  return Math.ceil((animationSteps / 60) * 1000) + 80;
}

/** Wall-clock wait after applyCadView until orientation (+ optional fit) tweens finish. */
export function cadViewerViewCommandSettleMs(animationSteps: number, fit: boolean): number {
  const t = cadViewerOrientationTweenMs(animationSteps);
  return fit ? t * 2 : t;
}
