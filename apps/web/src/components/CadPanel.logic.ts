import type { OnshapeSyncedCadFile } from "@cadsense/contracts";
import type { CadViewerFrameComponentNode } from "../lib/cadViewerFrameProtocol";

export const CAD_MODEL_LOAD_TARGET_MS = 15_000;
export const CAD_MODEL_LOAD_TIMEOUT_MS = 120_000;
export const CAD_VIEWER_MODEL_SIZE_LIMIT_BYTES = 80 * 1024 * 1024;

export function formatCadModelBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown size";
  }
  const mib = bytes / (1024 * 1024);
  if (mib >= 1) {
    return `${mib.toFixed(mib >= 10 ? 1 : 2)} MiB`;
  }
  const kib = bytes / 1024;
  return `${Math.max(1, Math.round(kib))} KiB`;
}

export function getCadModelViewerBlocker(
  files: ReadonlyArray<Pick<OnshapeSyncedCadFile, "relativePath" | "sizeBytes">>,
): string | null {
  const oversizedFile = files.find(
    (file) =>
      typeof file.sizeBytes === "number" && file.sizeBytes > CAD_VIEWER_MODEL_SIZE_LIMIT_BYTES,
  );
  if (oversizedFile) {
    return [
      `The synced CAD preview is ${formatCadModelBytes(oversizedFile.sizeBytes ?? 0)}, above the ${formatCadModelBytes(CAD_VIEWER_MODEL_SIZE_LIMIT_BYTES)} interactive viewer limit.`,
      "Cadsense skipped importing it so the rest of the app stays responsive. Sync or export a smaller preview mesh before opening the viewer.",
    ].join(" ");
  }

  const knownSizes = files
    .map((file) => file.sizeBytes)
    .filter((size): size is number => typeof size === "number" && Number.isFinite(size));
  if (knownSizes.length === files.length) {
    const totalBytes = knownSizes.reduce((sum, size) => sum + size, 0);
    if (totalBytes > CAD_VIEWER_MODEL_SIZE_LIMIT_BYTES) {
      return [
        `The synced CAD preview assets total ${formatCadModelBytes(totalBytes)}, above the ${formatCadModelBytes(CAD_VIEWER_MODEL_SIZE_LIMIT_BYTES)} interactive viewer limit.`,
        "Cadsense skipped importing them so the rest of the app stays responsive. Sync or export a smaller preview mesh before opening the viewer.",
      ].join(" ");
    }
  }

  return null;
}

export function cadViewerFrameUrl(location: Location = window.location): string {
  return new URL("/cad-viewer-frame", location.href).toString();
}

export function cadViewerFileName(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  const slashIndex = normalized.lastIndexOf("/");
  const leaf = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
  return leaf.trim().length > 0 ? leaf : "model.cad";
}

export function cadOnshapeModelQueryIdentity(
  onshapeContext: {
    readonly connectionId: string;
    readonly entityId: string;
    readonly entityKind: string;
    readonly reference: {
      readonly baseUrl: string;
      readonly documentId?: string | undefined;
      readonly workspaceId?: string | undefined;
      readonly versionId?: string | undefined;
      readonly microversionId?: string | undefined;
      readonly elementId?: string | undefined;
    };
    readonly lastSyncedRelativePath?: string | undefined;
    readonly lastSyncedAt?: string | undefined;
  } | null,
): readonly unknown[] {
  if (!onshapeContext) {
    return [null];
  }
  return [
    onshapeContext.connectionId,
    onshapeContext.entityKind,
    onshapeContext.entityId,
    onshapeContext.reference.baseUrl,
    onshapeContext.reference.documentId,
    onshapeContext.reference.workspaceId ?? null,
    onshapeContext.reference.versionId ?? null,
    onshapeContext.reference.microversionId ?? null,
    onshapeContext.reference.elementId,
    onshapeContext.lastSyncedRelativePath ?? null,
    onshapeContext.lastSyncedAt ?? null,
  ];
}

export function applyCadComponentVisibility(
  components: ReadonlyArray<CadViewerFrameComponentNode>,
  visibilityByComponentId: Readonly<Record<string, boolean>>,
): CadViewerFrameComponentNode[] {
  const componentById = new Map<string, CadViewerFrameComponentNode>();
  const childrenByParentId = new Map<string | undefined, CadViewerFrameComponentNode[]>();
  for (const component of components) {
    componentById.set(component.id, component);
    const children = childrenByParentId.get(component.parentId);
    if (children) {
      children.push(component);
    } else {
      childrenByParentId.set(component.parentId, [component]);
    }
  }

  const ownVisibilityById = new Map<string, boolean>();
  const resolveOwnVisibility = (
    component: CadViewerFrameComponentNode,
    parentVisible: boolean,
  ): boolean => {
    const explicitVisible = visibilityByComponentId[component.id];
    const ownVisible = typeof explicitVisible === "boolean" ? explicitVisible : component.visible;
    const effectiveOwnVisible = parentVisible && ownVisible;
    ownVisibilityById.set(component.id, effectiveOwnVisible);
    for (const child of childrenByParentId.get(component.id) ?? []) {
      resolveOwnVisibility(child, effectiveOwnVisible);
    }
    return effectiveOwnVisible;
  };

  const visitedRootIds = new Set<string>();
  for (const component of components) {
    if (component.parentId && componentById.has(component.parentId)) {
      continue;
    }
    visitedRootIds.add(component.id);
    resolveOwnVisibility(component, true);
  }
  for (const component of components) {
    if (!visitedRootIds.has(component.id) && !ownVisibilityById.has(component.id)) {
      resolveOwnVisibility(component, true);
    }
  }

  const effectiveVisibilityById = new Map<string, boolean>();
  const resolveSubtreeVisibility = (component: CadViewerFrameComponentNode): boolean => {
    const children = childrenByParentId.get(component.id) ?? [];
    const ownVisible = ownVisibilityById.get(component.id) ?? component.visible;
    const childVisible = children.some((child) => resolveSubtreeVisibility(child));
    const visible = ownVisible && (children.length === 0 || childVisible);
    effectiveVisibilityById.set(component.id, visible);
    return visible;
  };
  for (const component of components) {
    if (component.parentId && componentById.has(component.parentId)) {
      continue;
    }
    resolveSubtreeVisibility(component);
  }
  for (const component of components) {
    if (!effectiveVisibilityById.has(component.id)) {
      resolveSubtreeVisibility(component);
    }
  }

  return components.map((component) => {
    const visible = effectiveVisibilityById.get(component.id);
    return typeof visible === "boolean" && visible !== component.visible
      ? { ...component, visible }
      : component;
  });
}

export function cadComponentVisibilityCommandsForScopeChange(
  previousVisibilityByComponentId: Readonly<Record<string, boolean>>,
  nextVisibilityByComponentId: Readonly<Record<string, boolean>>,
): Array<{ readonly componentId: string; readonly visible: boolean }> {
  const componentIds = new Set([
    ...Object.keys(previousVisibilityByComponentId),
    ...Object.keys(nextVisibilityByComponentId),
  ]);
  const commands: Array<{ readonly componentId: string; readonly visible: boolean }> = [];
  for (const componentId of componentIds) {
    const previousVisible = previousVisibilityByComponentId[componentId] ?? true;
    const nextVisible = nextVisibilityByComponentId[componentId] ?? true;
    if (previousVisible !== nextVisible) {
      commands.push({ componentId, visible: nextVisible });
    }
  }
  return commands;
}
