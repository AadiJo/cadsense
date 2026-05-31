import { scopedProjectKey, scopeProjectRef } from "@cadsense/client-runtime";
import type { ScopedProjectRef, SidebarProjectGroupingMode } from "@cadsense/contracts";
import type { UnifiedSettings } from "@cadsense/contracts/settings";
import { normalizeProjectPathForComparison } from "./lib/projectPaths";
import type { Project } from "./types";

export interface ProjectGroupingSettings {
  sidebarProjectGroupingMode: SidebarProjectGroupingMode;
  sidebarProjectGroupingOverrides: Record<string, SidebarProjectGroupingMode>;
}

export type ProjectGroupingMode = SidebarProjectGroupingMode;

export function selectProjectGroupingSettings(_settings: UnifiedSettings): ProjectGroupingSettings {
  return {
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
  };
}

export function resolveProjectDisplayName(
  project: Pick<Project, "name" | "externalContext">,
): string {
  const trimmedName = project.name.trim();
  if (trimmedName.length > 0) {
    return trimmedName;
  }

  if (project.externalContext?.provider === "onshape") {
    const breadcrumbLabel = project.externalContext.onshape.breadcrumb.join(" > ").trim();
    if (breadcrumbLabel.length > 0) {
      return breadcrumbLabel;
    }
    const entityName = project.externalContext.onshape.name.trim();
    if (entityName.length > 0) {
      return entityName;
    }
  }

  return project.name;
}

function uniqueNonEmptyValues(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function deriveRepositoryRelativeProjectPath(
  project: Pick<Project, "cwd" | "repositoryIdentity">,
): string | null {
  const rootPath = project.repositoryIdentity?.rootPath?.trim();
  if (!rootPath) {
    return null;
  }

  const normalizedProjectPath = normalizeProjectPathForComparison(project.cwd);
  const normalizedRootPath = normalizeProjectPathForComparison(rootPath);
  if (normalizedProjectPath.length === 0 || normalizedRootPath.length === 0) {
    return null;
  }

  if (normalizedProjectPath === normalizedRootPath) {
    return "";
  }

  const separator = normalizedRootPath.includes("\\") ? "\\" : "/";
  const rootPrefix = `${normalizedRootPath}${separator}`;
  if (!normalizedProjectPath.startsWith(rootPrefix)) {
    return null;
  }

  return normalizedProjectPath.slice(rootPrefix.length).replaceAll("\\", "/");
}

export function derivePhysicalProjectKeyFromPath(environmentId: string, cwd: string): string {
  return `${environmentId}:${normalizeProjectPathForComparison(cwd)}`;
}

export function derivePhysicalProjectKey(project: Pick<Project, "environmentId" | "cwd">): string {
  return derivePhysicalProjectKeyFromPath(project.environmentId, project.cwd);
}

export function deriveProjectGroupingOverrideKey(
  project: Pick<Project, "environmentId" | "cwd">,
): string {
  return derivePhysicalProjectKey(project);
}

// Key under which a project's manual sort order (projectOrder) is stored.
// Must stay aligned with the writer side in `uiStateStore.syncProjects` and
// the drag handlers in `Sidebar` so readers and writers agree.
export function getProjectOrderKey(project: Pick<Project, "environmentId" | "cwd">): string {
  return derivePhysicalProjectKey(project);
}

export function resolveProjectGroupingMode(
  _project: Pick<Project, "environmentId" | "cwd">,
  _settings: ProjectGroupingSettings,
): SidebarProjectGroupingMode {
  return "repository";
}

function deriveRepositoryScopedKey(
  project: Pick<Project, "cwd" | "repositoryIdentity">,
  groupingMode: SidebarProjectGroupingMode,
): string | null {
  const canonicalKey = project.repositoryIdentity?.canonicalKey;
  if (!canonicalKey) {
    return null;
  }

  if (groupingMode === "repository") {
    return canonicalKey;
  }

  const relativeProjectPath = deriveRepositoryRelativeProjectPath(project);
  if (relativeProjectPath === null) {
    return canonicalKey;
  }

  return relativeProjectPath.length === 0
    ? canonicalKey
    : `${canonicalKey}::${relativeProjectPath}`;
}

export function deriveLogicalProjectKey(
  project: Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity" | "externalContext">,
  options?: {
    groupingMode?: SidebarProjectGroupingMode;
  },
): string {
  if (project.externalContext?.provider === "onshape") {
    return `${project.environmentId}:onshape:${project.externalContext.onshape.connectionId}:${project.externalContext.onshape.entityId}`;
  }
  const groupingMode = options?.groupingMode ?? "repository";
  if (groupingMode === "separate") {
    return derivePhysicalProjectKey(project);
  }

  return (
    deriveRepositoryScopedKey(project, groupingMode) ??
    derivePhysicalProjectKey(project) ??
    scopedProjectKey(scopeProjectRef(project.environmentId, project.id))
  );
}

export function deriveLogicalProjectKeyFromSettings(
  project: Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity" | "externalContext">,
  settings: ProjectGroupingSettings,
): string {
  return deriveLogicalProjectKey(project, {
    groupingMode: resolveProjectGroupingMode(project, settings),
  });
}

export function deriveLogicalProjectKeyFromRef(
  projectRef: ScopedProjectRef,
  project:
    | Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity" | "externalContext">
    | null
    | undefined,
  options?: {
    groupingMode?: SidebarProjectGroupingMode;
  },
): string {
  return project ? deriveLogicalProjectKey(project, options) : scopedProjectKey(projectRef);
}

export function deriveProjectGroupLabel(input: {
  representative: Pick<Project, "name" | "repositoryIdentity" | "externalContext">;
  members: ReadonlyArray<Pick<Project, "name" | "repositoryIdentity" | "externalContext">>;
}): string {
  const onshapeNames = uniqueNonEmptyValues(
    input.members.map((member) =>
      member.externalContext?.provider === "onshape" ? resolveProjectDisplayName(member) : null,
    ),
  );
  if (onshapeNames.length === 1) {
    return onshapeNames[0]!;
  }
  const sharedDisplayNames = uniqueNonEmptyValues(
    input.members.map((member) => member.repositoryIdentity?.displayName),
  );
  if (sharedDisplayNames.length === 1) {
    return sharedDisplayNames[0]!;
  }

  const sharedRepositoryNames = uniqueNonEmptyValues(
    input.members.map((member) => member.repositoryIdentity?.name),
  );
  if (sharedRepositoryNames.length === 1) {
    return sharedRepositoryNames[0]!;
  }

  return input.representative.name;
}
