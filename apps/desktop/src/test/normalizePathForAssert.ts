/** Normalize separators and drop `C:`-style prefixes so path assertions match across OS hosts. */
export function normalizePathForAssert(path: string): string {
  return path.replaceAll("\\", "/").replace(/^[a-zA-Z]:\/?/iu, "/");
}
