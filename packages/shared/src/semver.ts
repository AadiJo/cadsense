interface ParsedSemver {
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  readonly prerelease: ReadonlyArray<string>;
}

const SEMVER_NUMBER_SEGMENT = /^\d+$/;
const SEMVER_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function normalizeSemverVersion(version: string): string {
  const trimmed = version.trim();
  const buildIndex = trimmed.indexOf("+");
  const build = buildIndex >= 0 ? trimmed.slice(buildIndex) : "";
  const withoutBuild = buildIndex >= 0 ? trimmed.slice(0, buildIndex) : trimmed;
  const prereleaseIndex = withoutBuild.indexOf("-");
  const prerelease = prereleaseIndex >= 0 ? withoutBuild.slice(prereleaseIndex) : "";
  const main = prereleaseIndex >= 0 ? withoutBuild.slice(0, prereleaseIndex) : withoutBuild;
  const segments = (main ?? "")
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 2) {
    segments.push("0");
  }

  return `${segments.join(".")}${prerelease}${build}`;
}

export function parseSemver(value: string): ParsedSemver | null {
  if (/\s/.test(value.trim())) {
    return null;
  }
  const match = normalizeSemverVersion(value).match(SEMVER_PATTERN);
  if (!match) return null;
  const [, majorSegment, minorSegment, patchSegment, prerelease = ""] = match;
  if (majorSegment === undefined || minorSegment === undefined || patchSegment === undefined) {
    return null;
  }
  const prereleaseIdentifiers = prerelease === "" ? [] : prerelease.split(".");
  if (
    prereleaseIdentifiers.some(
      (identifier) =>
        SEMVER_NUMBER_SEGMENT.test(identifier) &&
        identifier.length > 1 &&
        identifier.startsWith("0"),
    )
  ) {
    return null;
  }

  return {
    major: majorSegment,
    minor: minorSegment,
    patch: patchSegment,
    prerelease: prereleaseIdentifiers,
  };
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = SEMVER_NUMBER_SEGMENT.test(left);
  const rightNumeric = SEMVER_NUMBER_SEGMENT.test(right);

  if (leftNumeric && rightNumeric) {
    return compareNumericIdentifier(left, right);
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSemverVersions(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right);
  }

  for (const segment of ["major", "minor", "patch"] as const) {
    const comparison = compareNumericIdentifier(parsedLeft[segment], parsedRight[segment]);
    if (comparison !== 0) {
      return comparison;
    }
  }

  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) {
    return 0;
  }
  if (parsedLeft.prerelease.length === 0) {
    return 1;
  }
  if (parsedRight.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

/**
 * Small semver range checker for CLI/runtime gates.
 *
 * Keep the function body valid plain JavaScript: SSH startup stringifies this
 * function and runs it on remote Node versions before TypeScript support is known.
 *
 * @param rawVersion Version string, with or without a leading `v`.
 * @param range Space-separated comparators, with `||` range groups.
 * @returns Whether `rawVersion` satisfies the supported range syntax.
 */
export const satisfiesSemverRange: (rawVersion: string, range: string) => boolean =
  function satisfiesSemverRange(rawVersion, range) {
    const normalizedVersion = String(rawVersion).trim().replace(/^v/, "");
    const versionMatch = normalizedVersion.match(
      /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?$/,
    );
    if (!versionMatch) {
      return false;
    }

    const version = {
      major: Number(versionMatch[1]),
      minor: Number(versionMatch[2] || 0),
      patch: Number(versionMatch[3] || 0),
    };

    return range.split("||").some((group) => {
      const comparators = group.trim().split(/\s+/).filter(Boolean);
      if (comparators.length === 0) {
        return false;
      }
      return comparators.every((comparator) => {
        const match = comparator.trim().match(/^(\^|>=|>|<=|<|=)?\s*v?(\d+(?:\.\d+){0,2})$/);
        if (!match) {
          return false;
        }
        const targetVersion = match[2];
        if (targetVersion === undefined) {
          return false;
        }
        const targetMatch = targetVersion.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
        if (!targetMatch) {
          return false;
        }
        const target = {
          major: Number(targetMatch[1]),
          minor: Number(targetMatch[2] || 0),
          patch: Number(targetMatch[3] || 0),
        };
        const compared =
          version.major !== target.major
            ? version.major > target.major
              ? 1
              : -1
            : version.minor !== target.minor
              ? version.minor > target.minor
                ? 1
                : -1
              : version.patch !== target.patch
                ? version.patch > target.patch
                  ? 1
                  : -1
                : 0;
        const operator = match[1] || "=";
        switch (operator) {
          case "^":
            if (compared < 0) {
              return false;
            }
            if (target.major > 0) {
              return version.major === target.major;
            }
            if (target.minor > 0) {
              return version.major === 0 && version.minor === target.minor;
            }
            return version.major === 0 && version.minor === 0 && version.patch === target.patch;
          case ">=":
            return compared >= 0;
          case ">":
            return compared > 0;
          case "<=":
            return compared <= 0;
          case "<":
            return compared < 0;
          case "=":
            return compared === 0;
          default:
            return false;
        }
      });
    });
  };
