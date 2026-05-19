/**
 * Human- and model-facing description of fixed CAD views used by the CadSense CAD
 * panel (online-3d-viewer). Matches the direction vectors in the web client
 * `cadViewVector` helper: right-handed axes with +Z up (vertical), +X and +Y
 * horizontal.
 */
export const CAD_VIEW_ORIENTATION_GUIDE = [
  "Coordinate system: right-handed, +Z is up (vertical); +X and +Y span the horizontal plane.",
  "top: look straight down the +Z axis onto the XY plane (bird's-eye).",
  "bottom: look straight up from -Z (worm's-eye).",
  "front: camera on the -Y side of the model looking toward +Y, with +Z up on screen.",
  "back: camera on the +Y side looking toward -Y, +Z up.",
  "left: camera on the -X side looking toward +X, +Z up.",
  "right: camera on the +X side looking toward -X, +Z up.",
  "isometric: elevated diagonal from the (+X, -Y, +Z) direction so three faces are visible at once (classic CAD iso, Z still up).",
  "Close-up views use the same orientation names with a -close-up suffix, for example front-close-up or isometric-close-up, and move closer for detail inspection.",
].join(" ");
