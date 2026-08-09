const REPO = "AadiJo/Cadsense";

export const RELEASES_URL = `https://github.com/${REPO}/releases`;

const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_KEY = "cadsense-latest-release";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

function isReleaseAsset(value: unknown): value is ReleaseAsset {
  if (typeof value !== "object" || value === null) return false;
  const asset = value as Partial<ReleaseAsset>;
  return typeof asset.name === "string" && typeof asset.browser_download_url === "string";
}

function isRelease(value: unknown): value is Release {
  if (typeof value !== "object" || value === null) return false;
  const release = value as Partial<Release>;
  return (
    typeof release.tag_name === "string" &&
    typeof release.html_url === "string" &&
    Array.isArray(release.assets) &&
    release.assets.every(isReleaseAsset)
  );
}

function readCachedRelease(): Release | null {
  try {
    const cached = sessionStorage.getItem(CACHE_KEY);
    if (cached === null) return null;
    const parsed: unknown = JSON.parse(cached);
    if (isRelease(parsed)) return parsed;
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    // Storage can be unavailable, and stale cache data should not block a fresh request.
    try {
      sessionStorage.removeItem(CACHE_KEY);
    } catch {
      // Ignore storage access failures and continue without a cache.
    }
  }
  return null;
}

export async function fetchLatestRelease(): Promise<Release> {
  const cached = readCachedRelease();
  if (cached) return cached;

  const response = await fetch(API_URL, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub release request failed with status ${response.status}.`);
  }
  const data: unknown = await response.json();
  if (!isRelease(data)) {
    throw new Error("GitHub release response was invalid.");
  }

  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {
    // A successful release lookup should not fail when browser storage is unavailable.
  }

  return data;
}
