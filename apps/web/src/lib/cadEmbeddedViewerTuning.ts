type Online3DViewerModule = typeof import("online-3d-viewer");

/**
 * Explicit mesh edge overlay off (same as the library default for `ViewerMainModel`, but kept
 * obvious so future CAD work does not accidentally enable edge extraction for large meshes).
 */
export function cadEmbeddedViewerEdgeSettings(module: Online3DViewerModule) {
  return new module.EdgeSettings(false, new module.RGBColor(0, 0, 0), 1);
}

/**
 * We intentionally do not pass `environmentSettings` into EmbeddedViewer: its constructor
 * forwards the value to `SetEnvironmentMapSettings`, which always starts a cube texture load. The
 * default shading model already uses no env map and `backgroundIsEnvMap: false`, which is what we
 * want for a lightweight sidebar preview.
 */
