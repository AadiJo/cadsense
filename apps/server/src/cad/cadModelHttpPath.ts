/** HTTP path prefix for authenticated CAD model file downloads. */
export const CAD_MODEL_HTTP_PATH = "/api/onshape/cad-model";

export function posixFileBasename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

/**
 * Builds a URL whose last path segment carries the file extension (e.g. `.glb`, `.step`)
 * so browser-based CAD viewers can infer format from the URL string.
 */
export function buildCadModelUrl(cwd: string, relativePath: string): string {
  const leaf = posixFileBasename(relativePath);
  const params = new URLSearchParams({ cwd, path: relativePath });
  return `${CAD_MODEL_HTTP_PATH}/${encodeURIComponent(leaf)}?${params.toString()}`;
}

export function parseCadModelLeafFromPathname(
  pathname: string,
  routePath: string = CAD_MODEL_HTTP_PATH,
): string | null {
  if (pathname === routePath || pathname === `${routePath}/`) {
    return null;
  }
  const prefix = `${routePath}/`;
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  return decodeURIComponent(pathname.slice(prefix.length));
}
