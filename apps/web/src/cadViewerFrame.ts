import type { CadCameraVector, CadView } from "@cadsense/contracts";
import type * as ThreeNamespace from "three";
import type { OrbitControls as OrbitControlsInstance } from "three/examples/jsm/controls/OrbitControls.js";

import { cadViewIsCloseUp, cadViewVector } from "./lib/cadView";
import {
  cadViewerOrientationTweenMs,
  cadViewerViewCommandSettleMs,
} from "./lib/cadViewerCameraTransition";
import { cadEmbeddedViewerEdgeSettings } from "./lib/cadEmbeddedViewerTuning";
import { getThreeMfRootModelByteLength, parseThreeMfFast } from "./lib/cadThreeMfFastParser";
import {
  CAD_VIEWER_FRAME_PARENT_SOURCE,
  CAD_VIEWER_FRAME_SOURCE,
  type CadViewerFrameComponentNode,
  type CadViewerFrameFileDescriptor,
  type CadViewerFrameFilePayload,
  type CadViewerFrameLoadStage,
  type CadViewerFrameLoadStats,
  type CadViewerFrameRequest,
  type CadViewerFrameResponseInput,
} from "./lib/cadViewerFrameProtocol";

type Online3DViewerModule = typeof import("online-3d-viewer");
type EmbeddedViewerInstance = InstanceType<Online3DViewerModule["EmbeddedViewer"]>;
type ThreeModule = typeof ThreeNamespace;
type ThreeObject3D = ThreeNamespace.Object3D;
type ThreeGroup = ThreeNamespace.Group;
type ThreePerspectiveCamera = ThreeNamespace.PerspectiveCamera;
type ThreeScene = ThreeNamespace.Scene;
type ThreeSphere = ThreeNamespace.Sphere;
type ThreeWebGLRenderer = ThreeNamespace.WebGLRenderer;

/** Minimal type surface for three.js's ThreeMFLoader used in the direct fast path. */
interface ThreeMFLoaderInstance {
  load(
    url: string,
    onLoad: (group: ThreeGroup) => void,
    onProgress: undefined,
    onError: (err: unknown) => void,
  ): void;
  parse(data: ArrayBuffer): ThreeGroup;
}

interface ThreeViewerState {
  readonly kind: "three";
  readonly three: ThreeModule;
  readonly renderer: ThreeWebGLRenderer;
  readonly scene: ThreeScene;
  readonly camera: ThreePerspectiveCamera;
  readonly controls: OrbitControlsInstance;
  readonly group: ThreeObject3D;
  readonly boundingSphere: ThreeSphere;
  exploded: boolean;
  componentTree: CadViewerFrameComponentNode[];
  componentObjectsById: Map<string, ThreeObject3D>;
  readonly ownsModelAssets: boolean;
}

interface CachedThreeModel {
  readonly group: ThreeObject3D;
  readonly boundingSphere: ThreeSphere;
  readonly bytes: number;
}

const rootElement = document.getElementById("root");
if (!(rootElement instanceof HTMLDivElement)) {
  throw new Error("CAD viewer frame root is missing.");
}
const root: HTMLDivElement = rootElement;
document.documentElement.style.background = "transparent";
document.body.style.background = "transparent";
document.body.style.margin = "0";
document.body.style.overflow = "hidden";
root.style.width = "100%";
root.style.height = "100%";
root.style.overflow = "hidden";
root.replaceChildren();

let modulePromise: Promise<Online3DViewerModule> | null = null;
let moduleRef: Online3DViewerModule | null = null;
let embeddedViewerRef: EmbeddedViewerInstance | null = null;
let threeViewerRef: ThreeViewerState | null = null;
let cadViewFollowUp: ReturnType<typeof setTimeout> | null = null;
let resizeAnimationFrame = 0;
let explodedAnimationFrame = 0;
let zoomToFitAnimationFrame = 0;
const threeModelCache = new Map<string, CachedThreeModel>();
const THREE_MODEL_CACHE_LIMIT = 3;
const MATERIAL_DARKEN_FACTOR = 0.42;
const MATERIAL_SATURATION_FACTOR = 1.25;
const CANVAS_COLOR_GRADE_FILTER = "brightness(0.76) contrast(1.28) saturate(1.45)";
const EXPLODED_DISTANCE_FACTOR = 0.18;
const EXPLODED_ANIMATION_MS = 260;
const ZOOM_TO_FIT_VIEWPORT_FILL = 1.3;
const ZOOM_TO_FIT_ANIMATION_MS = 240;
const MODEL_REVEAL_TRANSITION = "opacity 300ms ease-out";
const COMPONENT_ID_KEY = "cadSenseComponentId";

function postToParent(message: CadViewerFrameResponseInput): void {
  window.parent.postMessage({ source: CAD_VIEWER_FRAME_SOURCE, ...message }, "*");
}

function postLoadStatus(
  requestId: string,
  startedAt: number,
  stage: CadViewerFrameLoadStage,
): void {
  postToParent({
    type: "status",
    requestId,
    stage,
    elapsedMs: performance.now() - startedAt,
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || "Unknown error inside viewer iframe.";
  }
  const str = String(error);
  return str.trim() ? str : "Unknown error inside viewer iframe.";
}

function cancelCadViewFollowUp(): void {
  if (cadViewFollowUp !== null) {
    clearTimeout(cadViewFollowUp);
    cadViewFollowUp = null;
  }
}

function scheduleCadViewAfterOrientation(delayMs: number, fn: () => void): void {
  cancelCadViewFollowUp();
  cadViewFollowUp = setTimeout(() => {
    cadViewFollowUp = null;
    fn();
  }, delayMs);
}

function renderViewer(viewer: unknown): void {
  const candidate = viewer as { Render?: () => void; Draw?: () => void };
  if (typeof candidate.Render === "function") {
    candidate.Render();
    return;
  }
  if (typeof candidate.Draw === "function") {
    candidate.Draw();
  }
}

function setViewerSurfacesVisible(visible: boolean): void {
  for (const canvas of root.querySelectorAll("canvas")) {
    canvas.style.transition = MODEL_REVEAL_TRANSITION;
    canvas.style.opacity = visible ? "1" : "0";
  }
}

function revealViewerSurfaces(): void {
  requestAnimationFrame(() => {
    setViewerSurfacesVisible(true);
  });
}

function applyCadView(
  module: Online3DViewerModule,
  embeddedViewer: EmbeddedViewerInstance,
  view: CadView,
  fit: boolean,
): void {
  const { direction, up } = cadViewVector(view);
  applyCadCamera(module, embeddedViewer, direction, up, fit, cadViewIsCloseUp(view));
}

function applyCadCamera(
  module: Online3DViewerModule,
  embeddedViewer: EmbeddedViewerInstance,
  direction: CadCameraVector,
  up: CadCameraVector | undefined,
  fit: boolean,
  closeUp: boolean,
): void {
  cancelCadViewFollowUp();
  const viewer = embeddedViewer.GetViewer() as ReturnType<EmbeddedViewerInstance["GetViewer"]> & {
    navigation: {
      MoveCamera: (camera: InstanceType<Online3DViewerModule["Camera"]>, stepCount: number) => void;
    };
    settings?: { animationSteps?: number };
  };
  const sphere = viewer.GetBoundingSphere(() => true);
  if (!sphere) {
    return;
  }

  const directionLength = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  const normalizedDirection = direction.map((value) => value / directionLength) as [
    number,
    number,
    number,
  ];
  const cameraUp = up ?? [0, 0, 1];
  let distance = Math.max(sphere.radius * 2.8, 10);
  if (fit) {
    let fieldOfView = 45 / 2.0;
    const canvas = (
      viewer as { GetCanvas?: () => { width: number; height: number } | null }
    ).GetCanvas?.();
    if (canvas && canvas.width < canvas.height) {
      fieldOfView = (fieldOfView * canvas.width) / canvas.height;
    }
    const degRad = Math.PI / 180.0;
    const fitDistance = sphere.radius / Math.sin(fieldOfView * degRad);
    if (fitDistance > 0 && fitDistance !== Infinity) {
      distance = fitDistance;
    }
  }
  if (closeUp) {
    distance *= 0.44;
  }

  const center = sphere.center;
  const camera = new module.Camera(
    new module.Coord3D(
      center.x + normalizedDirection[0] * distance,
      center.y + normalizedDirection[1] * distance,
      center.z + normalizedDirection[2] * distance,
    ),
    new module.Coord3D(center.x, center.y, center.z),
    new module.Coord3D(cameraUp[0], cameraUp[1], cameraUp[2]),
    45,
  );

  const steps = viewer.settings?.animationSteps ?? 40;
  viewer.navigation.MoveCamera(camera, steps);
  renderViewer(viewer);
  const delayMs = cadViewerOrientationTweenMs(steps);
  scheduleCadViewAfterOrientation(delayMs, () => {
    viewer.AdjustClippingPlanesToSphere(sphere);
    renderViewer(viewer);
  });
}

function zoomEmbeddedViewerToFit(embeddedViewer: EmbeddedViewerInstance): void {
  cancelCadViewFollowUp();
  const viewer = embeddedViewer.GetViewer() as ReturnType<EmbeddedViewerInstance["GetViewer"]> & {
    FitSphereToWindow: (boundingSphere: unknown, animation: boolean) => void;
    AdjustClippingPlanesToSphere: (boundingSphere: unknown) => void;
  };
  const sphere = viewer.GetBoundingSphere(() => true);
  if (!sphere) {
    return;
  }
  const fitSphere = {
    center: sphere.center,
    radius: sphere.radius / ZOOM_TO_FIT_VIEWPORT_FILL,
  };
  viewer.FitSphereToWindow(fitSphere, true);
  renderViewer(viewer);
  const steps =
    (viewer as { settings?: { animationSteps?: number } }).settings?.animationSteps ?? 40;
  scheduleCadViewAfterOrientation(cadViewerOrientationTweenMs(steps), () => {
    viewer.AdjustClippingPlanesToSphere(fitSphere);
    renderViewer(viewer);
  });
}

function isThreeMaterial(value: unknown): value is ThreeNamespace.Material {
  return typeof value === "object" && value !== null && "dispose" in value;
}

function disposeThreeViewer(state: ThreeViewerState): void {
  state.controls.dispose();
  if (state.ownsModelAssets) {
    disposeThreeGroupAssets(state.group);
  }
  state.renderer.dispose();
  state.renderer.domElement.remove();
}

function destroyViewer(): void {
  cancelCadViewFollowUp();
  if (resizeAnimationFrame !== 0) {
    cancelAnimationFrame(resizeAnimationFrame);
    resizeAnimationFrame = 0;
  }
  if (explodedAnimationFrame !== 0) {
    cancelAnimationFrame(explodedAnimationFrame);
    explodedAnimationFrame = 0;
  }
  if (zoomToFitAnimationFrame !== 0) {
    cancelAnimationFrame(zoomToFitAnimationFrame);
    zoomToFitAnimationFrame = 0;
  }
  embeddedViewerRef?.Destroy();
  embeddedViewerRef = null;
  if (threeViewerRef) {
    disposeThreeViewer(threeViewerRef);
    threeViewerRef = null;
  }
  root.replaceChildren();
}

function ensureModule(): Promise<Online3DViewerModule> {
  if (moduleRef) {
    return Promise.resolve(moduleRef);
  }
  modulePromise ??= import("online-3d-viewer").then((module) => {
    moduleRef = module;
    return module;
  });
  return modulePromise;
}

function makeFile(payload: CadViewerFrameFilePayload): File {
  return new File([payload.buffer], payload.name, {
    type: payload.type ?? "application/octet-stream",
  });
}

function parseContentLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function fetchDescriptorAsFilePayload(
  descriptor: CadViewerFrameFileDescriptor,
): Promise<CadViewerFrameFilePayload> {
  const response = await fetch(descriptor.url, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch CAD model asset '${descriptor.name}': HTTP ${response.status}`,
    );
  }
  const contentLength = parseContentLength(response.headers);
  const buffer = await response.arrayBuffer();
  const type =
    descriptor.type ??
    response.headers.get("content-type") ??
    (contentLength !== null ? "application/octet-stream" : undefined);
  return {
    name: descriptor.name,
    buffer,
    ...(type !== undefined ? { type } : {}),
  };
}

function throttleNavigationUpdates(embeddedViewer: EmbeddedViewerInstance): void {
  const localViewer = embeddedViewer.GetViewer() as {
    navigation?: {
      callbacks?: { onUpdate?: () => void };
      _cadSenseThrottled?: boolean;
    };
  };
  const navigation = localViewer.navigation;
  if (!navigation?.callbacks?.onUpdate || navigation._cadSenseThrottled) {
    return;
  }

  navigation._cadSenseThrottled = true;
  const originalUpdate = navigation.callbacks.onUpdate;
  let updatePending = false;
  navigation.callbacks.onUpdate = () => {
    if (updatePending) {
      return;
    }
    updatePending = true;
    requestAnimationFrame(() => {
      updatePending = false;
      originalUpdate.apply(navigation.callbacks);
    });
  };
}

/**
 * Size threshold (in bytes) above which we use the direct three.js fast path for 3MF files.
 * Below this threshold, the standard online-3d-viewer pipeline is fast enough.
 */
const DIRECT_3MF_THRESHOLD_BYTES = 5 * 1024 * 1024;
const FAST_3MF_XML_THRESHOLD_BYTES = 32 * 1024 * 1024;

function looksLike3mf(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return value.toLowerCase().includes(".3mf");
}

function is3mfDescriptorFile(
  files: ReadonlyArray<Pick<CadViewerFrameFileDescriptor, "name" | "type" | "url">>,
): boolean {
  if (files.length !== 1) {
    return false;
  }
  const file = files[0]!;
  return (
    looksLike3mf(file.name) ||
    looksLike3mf(file.url) ||
    file.type === "model/3mf" ||
    file.type === "application/vnd.ms-package.3dmanufacturing-3dmodel+xml"
  );
}

function is3mfPayloadFile(
  files: ReadonlyArray<Pick<CadViewerFrameFilePayload, "name" | "type">>,
): boolean {
  if (files.length !== 1) {
    return false;
  }
  const file = files[0]!;
  return (
    looksLike3mf(file.name) ||
    file.type === "model/3mf" ||
    file.type === "application/vnd.ms-package.3dmanufacturing-3dmodel+xml"
  );
}

function descriptorCacheKey(file: CadViewerFrameFileDescriptor): string {
  return `${file.url}\0${file.sizeBytes ?? "unknown"}`;
}

function disposeThreeGroupAssets(group: ThreeObject3D): void {
  group.traverse((child) => {
    const maybeMesh = child as Partial<ThreeNamespace.Mesh>;
    maybeMesh.geometry?.dispose();
    const materials = Array.isArray(maybeMesh.material)
      ? maybeMesh.material
      : maybeMesh.material
        ? [maybeMesh.material]
        : [];
    for (const material of materials) {
      if (isThreeMaterial(material)) {
        material.dispose();
      }
    }
  });
}

function rememberThreeModel(key: string, model: CachedThreeModel): void {
  if (threeModelCache.has(key)) {
    threeModelCache.delete(key);
  }
  threeModelCache.set(key, model);
  while (threeModelCache.size > THREE_MODEL_CACHE_LIMIT) {
    const oldestKey = threeModelCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    const oldest = threeModelCache.get(oldestKey);
    threeModelCache.delete(oldestKey);
    if (oldest) {
      disposeThreeGroupAssets(oldest.group);
    }
  }
}

function cloneCachedThreeModel(model: CachedThreeModel): CachedThreeModel {
  return {
    group: model.group.clone(true),
    boundingSphere: model.boundingSphere.clone(),
    bytes: model.bytes,
  };
}

function darkenColor(color: ThreeNamespace.Color): void {
  color.multiplyScalar(MATERIAL_DARKEN_FACTOR);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  color.setHSL(hsl.h, Math.min(1, hsl.s * MATERIAL_SATURATION_FACTOR), hsl.l);
}

function tuneThreeMaterial(material: ThreeNamespace.Material): void {
  const maybeColor = material as ThreeNamespace.Material & {
    color?: ThreeNamespace.Color;
    emissive?: ThreeNamespace.Color;
    shininess?: number;
    roughness?: number;
    metalness?: number;
    userData: Record<string, unknown>;
  };
  if (maybeColor.userData.cadSenseTuned === true) {
    return;
  }
  maybeColor.userData.cadSenseTuned = true;
  if (maybeColor.color) {
    darkenColor(maybeColor.color);
  }
  if (maybeColor.emissive) {
    maybeColor.emissive.setRGB(0, 0, 0);
  }
  if (typeof maybeColor.shininess === "number") {
    maybeColor.shininess = Math.min(maybeColor.shininess, 28);
  }
  if (typeof maybeColor.roughness === "number") {
    maybeColor.roughness = Math.max(maybeColor.roughness, 0.58);
  }
  if (typeof maybeColor.metalness === "number") {
    maybeColor.metalness = Math.min(maybeColor.metalness, 0.08);
  }
  material.needsUpdate = true;
}

function tuneThreeModelMaterials(group: ThreeObject3D, three: ThreeModule): void {
  group.traverse((child) => {
    const mesh = child as Partial<ThreeNamespace.Mesh>;
    if (!mesh.isMesh) {
      return;
    }
    mesh.visible = true;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of materials) {
      if (isThreeMaterial(mat)) {
        mat.side = three.DoubleSide;
        tuneThreeMaterial(mat);
      }
    }
  });
}

function prepareExplodedMeshes(
  group: ThreeObject3D,
  three: ThreeModule,
  boundingSphere: ThreeSphere,
): void {
  const tempBox = new three.Box3();
  const tempCenter = new three.Vector3();
  group.traverse((child) => {
    const mesh = child as Partial<ThreeNamespace.Mesh> & ThreeNamespace.Object3D;
    if (!mesh.isMesh) {
      return;
    }
    mesh.userData.cadSenseBasePosition ??= mesh.position.clone();
    if (mesh.userData.cadSenseExplodeDirection instanceof three.Vector3) {
      return;
    }

    const originalPosition = mesh.position.clone();
    const basePosition =
      mesh.userData.cadSenseBasePosition instanceof three.Vector3
        ? mesh.userData.cadSenseBasePosition
        : originalPosition;
    mesh.position.copy(basePosition);
    tempBox.setFromObject(mesh);
    tempBox.getCenter(tempCenter);
    mesh.position.copy(originalPosition);

    const direction = tempCenter.sub(boundingSphere.center);
    if (direction.lengthSq() < 1e-6) {
      direction.set(0, 0, 1);
    } else {
      direction.normalize();
    }
    mesh.userData.cadSenseExplodeDirection = direction.clone();
  });
}

function applyExplodedView(state: ThreeViewerState, enabled: boolean): void {
  if (explodedAnimationFrame !== 0) {
    cancelAnimationFrame(explodedAnimationFrame);
    explodedAnimationFrame = 0;
  }
  state.exploded = enabled;
  const { three, group, boundingSphere } = state;
  const offsetDistance = Math.max(boundingSphere.radius * EXPLODED_DISTANCE_FACTOR, 0.1);
  const animations: Array<{
    readonly mesh: ThreeNamespace.Object3D;
    readonly from: ThreeNamespace.Vector3;
    readonly to: ThreeNamespace.Vector3;
  }> = [];

  prepareExplodedMeshes(group, three, boundingSphere);
  group.traverse((child) => {
    const mesh = child as Partial<ThreeNamespace.Mesh> & ThreeNamespace.Object3D;
    if (!mesh.isMesh) {
      return;
    }
    const basePosition =
      mesh.userData.cadSenseBasePosition instanceof three.Vector3
        ? mesh.userData.cadSenseBasePosition
        : mesh.position.clone();
    const direction =
      mesh.userData.cadSenseExplodeDirection instanceof three.Vector3
        ? mesh.userData.cadSenseExplodeDirection
        : new three.Vector3(0, 0, 1);
    const target = enabled
      ? basePosition.clone().addScaledVector(direction, offsetDistance)
      : basePosition.clone();
    animations.push({ mesh, from: mesh.position.clone(), to: target });
  });

  const startedAt = performance.now();
  const step = () => {
    const elapsed = performance.now() - startedAt;
    const t = Math.min(1, elapsed / EXPLODED_ANIMATION_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    for (const animation of animations) {
      animation.mesh.position.lerpVectors(animation.from, animation.to, eased);
    }
    renderThreeViewer(state);
    if (t < 1) {
      explodedAnimationFrame = requestAnimationFrame(step);
      return;
    }
    explodedAnimationFrame = 0;
  };
  step();
}

function renderThreeViewer(state: ThreeViewerState): void {
  state.renderer.render(state.scene, state.camera);
}

function getComponentId(object: ThreeObject3D): string {
  const existing = object.userData[COMPONENT_ID_KEY];
  if (typeof existing === "string" && existing.length > 0) {
    return existing;
  }
  const id = `three-object-${object.id}`;
  object.userData[COMPONENT_ID_KEY] = id;
  return id;
}

function displayComponentName(object: ThreeObject3D, fallbackIndex: number): string {
  const name = object.name.trim();
  return name.length > 0 ? name : `Component ${fallbackIndex + 1}`;
}

function buildThreeComponentTree(state: Pick<ThreeViewerState, "group">): {
  readonly nodes: CadViewerFrameComponentNode[];
  readonly objectsById: Map<string, ThreeObject3D>;
} {
  const nodes: CadViewerFrameComponentNode[] = [];
  const objectsById = new Map<string, ThreeObject3D>();
  const includeObject = (object: ThreeObject3D) => {
    const mesh = object as Partial<ThreeNamespace.Mesh>;
    if (object === state.group) {
      return true;
    }
    if (mesh.isMesh === true) {
      return false;
    }
    return object.children.length > 0;
  };

  const visit = (object: ThreeObject3D, parentId: string | undefined) => {
    const componentId = includeObject(object) ? getComponentId(object) : undefined;
    const childParentId = componentId ?? parentId;
    if (componentId) {
      const mesh = object as Partial<ThreeNamespace.Mesh>;
      objectsById.set(componentId, object);
      nodes.push({
        id: componentId,
        ...(parentId ? { parentId } : {}),
        name: object === state.group ? "Model" : displayComponentName(object, nodes.length),
        kind: mesh.isMesh === true ? "part" : "assembly",
        hasChildren: object.children.some((child) => includeObject(child)),
        visible: object.visible,
      });
    }
    for (const child of object.children) {
      visit(child, childParentId);
    }
  };

  visit(state.group, undefined);
  if (nodes.length <= 1) {
    for (const object of state.group.children) {
      const mesh = object as Partial<ThreeNamespace.Mesh>;
      if (mesh.isMesh !== true) {
        continue;
      }
      const id = getComponentId(object);
      objectsById.set(id, object);
      nodes.push({
        id,
        parentId: getComponentId(state.group),
        name: displayComponentName(object, nodes.length),
        kind: "part",
        hasChildren: false,
        visible: object.visible,
      });
    }
  }
  return { nodes, objectsById };
}

function setThreeComponentVisibility(
  state: ThreeViewerState,
  componentId: string,
  visible: boolean,
): void {
  const object = state.componentObjectsById.get(componentId);
  if (!object) {
    throw new Error("CAD component was not found.");
  }
  object.visible = visible;
  state.componentTree = state.componentTree.map((node) =>
    node.id === componentId ? { ...node, visible } : node,
  );
  renderThreeViewer(state);
}

function resizeThreeViewer(state: ThreeViewerState): void {
  const rect = root.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || root.clientWidth || 1));
  const height = Math.max(1, Math.round(rect.height || root.clientHeight || 1));
  state.renderer.setSize(width, height, false);
  state.camera.aspect = width / height;
  state.camera.updateProjectionMatrix();
  renderThreeViewer(state);
}

function applyThreeCadView(state: ThreeViewerState, view: CadView, fit: boolean): void {
  const { direction, up } = cadViewVector(view);
  applyThreeCadCamera(state, direction, up, fit, cadViewIsCloseUp(view));
}

function applyThreeCadCamera(
  state: ThreeViewerState,
  direction: CadCameraVector,
  up: CadCameraVector | undefined,
  fit: boolean,
  closeUp: boolean,
): void {
  cancelCadViewFollowUp();
  const { three, camera, controls, boundingSphere } = state;
  const normalizedDirection = new three.Vector3(direction[0], direction[1], direction[2]);
  if (normalizedDirection.lengthSq() === 0) {
    normalizedDirection.set(1, -1, 1);
  }
  normalizedDirection.normalize();
  const cameraUp = up ?? [0, 0, 1];

  const canvas = state.renderer.domElement;
  let distance = Math.max(boundingSphere.radius * 2.8, 10);
  if (fit) {
    let halfFov = camera.fov / 2;
    if (canvas.width < canvas.height) {
      halfFov = (halfFov * canvas.width) / Math.max(1, canvas.height);
    }
    const fitDistance = boundingSphere.radius / Math.sin(three.MathUtils.degToRad(halfFov));
    if (Number.isFinite(fitDistance) && fitDistance > 0) {
      distance = fitDistance;
    }
  }
  if (closeUp) {
    distance *= 0.44;
  }

  camera.position.copy(boundingSphere.center).addScaledVector(normalizedDirection, distance);
  camera.up.set(cameraUp[0], cameraUp[1], cameraUp[2]).normalize();
  camera.near = Math.max(0.01, distance - boundingSphere.radius * 4);
  camera.far = Math.max(distance + boundingSphere.radius * 4, 1_000);
  camera.lookAt(boundingSphere.center);
  camera.updateProjectionMatrix();
  controls.target.copy(boundingSphere.center);
  controls.update();
  renderThreeViewer(state);
}

function zoomThreeViewerToFit(state: ThreeViewerState): void {
  cancelCadViewFollowUp();
  if (zoomToFitAnimationFrame !== 0) {
    cancelAnimationFrame(zoomToFitAnimationFrame);
    zoomToFitAnimationFrame = 0;
  }
  const { three, camera, controls, boundingSphere } = state;
  const direction = new three.Vector3().subVectors(camera.position, controls.target);
  if (direction.lengthSq() === 0) {
    direction.set(1, -1, 1);
  }
  direction.normalize();

  const canvas = state.renderer.domElement;
  let halfFov = camera.fov / 2;
  if (canvas.width < canvas.height) {
    halfFov = (halfFov * canvas.width) / Math.max(1, canvas.height);
  }
  const fitDistance =
    boundingSphere.radius / ZOOM_TO_FIT_VIEWPORT_FILL / Math.sin(three.MathUtils.degToRad(halfFov));
  if (!Number.isFinite(fitDistance) || fitDistance <= 0) {
    return;
  }

  const startPosition = camera.position.clone();
  const startTarget = controls.target.clone();
  const targetPosition = boundingSphere.center.clone().addScaledVector(direction, fitDistance);
  const targetTarget = boundingSphere.center.clone();
  const startedAt = performance.now();

  const step = () => {
    const elapsed = performance.now() - startedAt;
    const t = Math.min(1, elapsed / ZOOM_TO_FIT_ANIMATION_MS);
    const eased = 1 - Math.pow(1 - t, 3);

    camera.position.lerpVectors(startPosition, targetPosition, eased);
    controls.target.lerpVectors(startTarget, targetTarget, eased);
    camera.near = Math.max(0.01, fitDistance - boundingSphere.radius * 4);
    camera.far = Math.max(fitDistance + boundingSphere.radius * 4, 1_000);
    camera.lookAt(controls.target);
    camera.updateProjectionMatrix();
    controls.update();
    renderThreeViewer(state);

    if (t < 1) {
      zoomToFitAnimationFrame = requestAnimationFrame(step);
      return;
    }
    zoomToFitAnimationFrame = 0;
  };
  step();
}

/**
 * Fast path: load a 3MF file by parsing it directly with three.js's ThreeMFLoader,
 * then rendering it with a tiny Three.js viewer. This bypasses online-3d-viewer's
 * expensive intermediate model conversion, which creates millions of individual JS
 * objects for large meshes (ConvertThreeGeometryToMesh + ConvertModelToThreeObject).
 */
async function loadFilesDirect3mfUrl(
  file: CadViewerFrameFileDescriptor,
  onStage?: (stage: CadViewerFrameLoadStage) => void,
): Promise<void> {
  destroyViewer();
  const [threeModule, threeMfModule, orbitControlsModule, fflateModule] = await Promise.all([
    import("three"),
    import("three/examples/jsm/loaders/3MFLoader.js") as Promise<{
      ThreeMFLoader: { new (): ThreeMFLoaderInstance };
    }>,
    import("three/examples/jsm/controls/OrbitControls.js"),
    import("three/examples/jsm/libs/fflate.module.js") as Promise<{
      unzipSync: (data: Uint8Array) => Record<string, Uint8Array>;
    }>,
  ]);
  onStage?.("direct-3mf-imports-loaded");

  const cacheKey = descriptorCacheKey(file);
  const cachedModel = threeModelCache.get(cacheKey);
  let model: CachedThreeModel;
  let ownsModelAssets = false;
  if (cachedModel) {
    model = cloneCachedThreeModel(cachedModel);
    prepareExplodedMeshes(model.group, threeModule, model.boundingSphere);
  } else {
    const response = await fetch(file.url, { credentials: "same-origin" });
    if (!response.ok) {
      throw new Error(`Failed to fetch CAD model asset '${file.name}': HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    const unzipped = fflateModule.unzipSync(new Uint8Array(buffer));
    onStage?.("direct-3mf-archive-expanded");
    const rootModelByteLength = getThreeMfRootModelByteLength(unzipped);

    let group: ThreeGroup;
    if (rootModelByteLength !== null && rootModelByteLength > FAST_3MF_XML_THRESHOLD_BYTES) {
      group = parseThreeMfFast({ three: threeModule, unzipped });
      onStage?.("direct-3mf-fast-parsed");
    } else {
      const loader = new threeMfModule.ThreeMFLoader();
      group = loader.parse(buffer);
      onStage?.("direct-3mf-model-parsed");
    }

    tuneThreeModelMaterials(group, threeModule);
    const box = new threeModule.Box3().setFromObject(group);
    const boundingSphere = new threeModule.Sphere();
    box.getBoundingSphere(boundingSphere);
    if (!Number.isFinite(boundingSphere.radius) || boundingSphere.radius <= 0) {
      boundingSphere.center.set(0, 0, 0);
      boundingSphere.radius = 1;
    }
    prepareExplodedMeshes(group, threeModule, boundingSphere);
    model = { group, boundingSphere, bytes: buffer.byteLength };
    rememberThreeModel(cacheKey, cloneCachedThreeModel(model));
    ownsModelAssets = false;
  }

  const renderer = new threeModule.WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = threeModule.SRGBColorSpace;
  renderer.toneMapping = threeModule.NoToneMapping;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.filter = CANVAS_COLOR_GRADE_FILTER;
  renderer.domElement.style.transition = MODEL_REVEAL_TRANSITION;
  renderer.domElement.style.opacity = "0";
  root.append(renderer.domElement);

  const scene = new threeModule.Scene();
  scene.add(model.group);
  scene.add(new threeModule.HemisphereLight(0xffffff, 0x101010, 0.46));
  scene.add(new threeModule.AmbientLight(0xffffff, 0.18));
  const keyLight = new threeModule.DirectionalLight(0xffffff, 0.95);
  keyLight.position.set(3, -4, 7);
  scene.add(keyLight);
  const fillLight = new threeModule.DirectionalLight(0xffffff, 0.2);
  fillLight.position.set(-5, 3, 3);
  scene.add(fillLight);

  const camera = new threeModule.PerspectiveCamera(45, 1, 0.01, 10_000);
  camera.up.set(0, 0, 1);
  const controls = new orbitControlsModule.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.screenSpacePanning = false;
  controls.target.copy(model.boundingSphere.center);
  const componentTree = buildThreeComponentTree({ group: model.group });

  const state: ThreeViewerState = {
    kind: "three",
    three: threeModule,
    renderer,
    scene,
    camera,
    controls,
    group: model.group,
    boundingSphere: model.boundingSphere,
    exploded: false,
    componentTree: componentTree.nodes,
    componentObjectsById: componentTree.objectsById,
    ownsModelAssets,
  };
  threeViewerRef = state;

  resizeThreeViewer(state);
  controls.addEventListener("change", () => renderThreeViewer(state));
  applyThreeCadView(state, "isometric", true);
  revealViewerSurfaces();
  onStage?.("direct-3mf-viewer-created");
}

async function loadFileDescriptors(
  files: ReadonlyArray<CadViewerFrameFileDescriptor>,
  onStage?: (stage: CadViewerFrameLoadStage) => void,
): Promise<CadViewerFrameLoadStats> {
  if (files.length === 0) {
    throw new Error("No CAD files were provided to the viewer.");
  }

  const startedAt = performance.now();
  if (is3mfDescriptorFile(files)) {
    await loadFilesDirect3mfUrl(files[0]!, onStage);
    const totalMs = performance.now() - startedAt;
    return {
      strategy: "three-3mf-direct-url",
      bytes: files[0]!.sizeBytes ?? 0,
      fetchMs: 0,
      importMs: totalMs,
      totalMs,
    };
  }

  const fetchStartedAt = performance.now();
  const payloadFiles = await Promise.all(files.map(fetchDescriptorAsFilePayload));
  const fetchMs = performance.now() - fetchStartedAt;
  onStage?.("fallback-files-fetched");
  if (
    is3mfPayloadFile(payloadFiles) &&
    (payloadFiles[0]!.buffer.byteLength >= DIRECT_3MF_THRESHOLD_BYTES ||
      payloadFiles[0]!.buffer.byteLength === 0)
  ) {
    destroyViewer();
    const objectUrl = URL.createObjectURL(makeFile(payloadFiles[0]!));
    try {
      await loadFilesDirect3mfUrl(
        {
          name: payloadFiles[0]!.name,
          url: objectUrl,
          sizeBytes: payloadFiles[0]!.buffer.byteLength,
          ...(payloadFiles[0]!.type === undefined ? {} : { type: payloadFiles[0]!.type }),
        },
        onStage,
      );
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    const totalMs = performance.now() - startedAt;
    return {
      strategy: "three-3mf-direct-url",
      bytes: payloadFiles[0]!.buffer.byteLength,
      fetchMs,
      importMs: totalMs - fetchMs,
      totalMs,
    };
  }
  await loadFiles(payloadFiles);
  onStage?.("fallback-viewer-loaded");
  const totalMs = performance.now() - startedAt;
  return {
    strategy: "online-3d-viewer-file-list",
    bytes: payloadFiles.reduce((sum, file) => sum + file.buffer.byteLength, 0),
    fetchMs,
    importMs: totalMs - fetchMs,
    totalMs,
  };
}

async function loadFiles(files: ReadonlyArray<CadViewerFrameFilePayload>): Promise<void> {
  if (files.length === 0) {
    throw new Error("No CAD files were provided to the viewer.");
  }

  destroyViewer();
  const module = await ensureModule();
  const embeddedViewer = new module.EmbeddedViewer(root, {
    backgroundColor: new module.RGBAColor(0, 0, 0, 0),
    defaultColor: new module.RGBColor(56, 60, 67),
    defaultLineColor: new module.RGBColor(40, 43, 49),
    edgeSettings: cadEmbeddedViewerEdgeSettings(module),
    onModelLoaded: () => undefined,
    onModelLoadFailed: () => undefined,
  });
  embeddedViewerRef = embeddedViewer;
  setViewerSurfacesVisible(false);

  await new Promise<void>((resolve, reject) => {
    embeddedViewer.parameters.onModelLoaded = () => {
      throttleNavigationUpdates(embeddedViewer);
      setViewerSurfacesVisible(false);
      resolve();
    };
    embeddedViewer.parameters.onModelLoadFailed = () => {
      reject(new Error("The synced CAD file could not be imported by the viewer."));
    };
    embeddedViewer.LoadModelFromFileList(files.map(makeFile));
  });

  applyCadView(module, embeddedViewer, "isometric", true);
  revealViewerSurfaces();
}

function getLoadedViewer(): {
  readonly module: Online3DViewerModule;
  readonly embeddedViewer: EmbeddedViewerInstance;
} {
  if (!moduleRef || !embeddedViewerRef) {
    throw new Error("CAD viewer is not loaded.");
  }
  return { module: moduleRef, embeddedViewer: embeddedViewerRef };
}

function getLoadedThreeViewer(): ThreeViewerState {
  if (!threeViewerRef) {
    throw new Error("CAD viewer is not loaded.");
  }
  return threeViewerRef;
}

async function capturePngBase64(input: {
  readonly view?: CadView;
  readonly fit: boolean;
}): Promise<string> {
  if (threeViewerRef) {
    const state = getLoadedThreeViewer();
    if (input.view) {
      applyThreeCadView(state, input.view, input.fit);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    renderThreeViewer(state);
    const dataUrl = state.renderer.domElement.toDataURL("image/png");
    const comma = dataUrl.indexOf(",");
    return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  }

  const { module, embeddedViewer } = getLoadedViewer();
  if (input.view) {
    applyCadView(module, embeddedViewer, input.view, input.fit);
    const viewerForTiming = embeddedViewer.GetViewer() as {
      settings?: { animationSteps?: number };
    };
    const settleMs = cadViewerViewCommandSettleMs(
      viewerForTiming.settings?.animationSteps ?? 40,
      input.fit,
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, settleMs);
    });
  }

  const viewer = embeddedViewer.GetViewer();
  const size = viewer.GetCanvasSize();
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  const capture = viewer as unknown as {
    GetImageAsDataUrl(width: number, height: number, isTransparent: boolean): string;
  };
  const dataUrl = capture.GetImageAsDataUrl(width, height, true);
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

async function handleRequest(request: CadViewerFrameRequest): Promise<{
  components?: ReadonlyArray<CadViewerFrameComponentNode>;
  pngBase64?: string;
  loadStats?: CadViewerFrameLoadStats;
} | void> {
  const requestStartedAt = performance.now();
  if (request.type === "load-file-urls") {
    postLoadStatus(request.requestId, requestStartedAt, "request-received");
  }

  switch (request.type) {
    case "load-files":
      await loadFiles(request.files);
      return;
    case "load-file-urls":
      return {
        loadStats: await loadFileDescriptors(request.files, (stage) =>
          postLoadStatus(request.requestId, requestStartedAt, stage),
        ),
      };
    case "set-view": {
      if (threeViewerRef) {
        applyThreeCadView(getLoadedThreeViewer(), request.view, request.fit);
        return;
      }
      const { module, embeddedViewer } = getLoadedViewer();
      applyCadView(module, embeddedViewer, request.view, request.fit);
      return;
    }
    case "set-camera": {
      if (threeViewerRef) {
        applyThreeCadCamera(
          getLoadedThreeViewer(),
          request.direction,
          request.up,
          request.fit,
          request.closeUp,
        );
        return;
      }
      const { module, embeddedViewer } = getLoadedViewer();
      applyCadCamera(
        module,
        embeddedViewer,
        request.direction,
        request.up,
        request.fit,
        request.closeUp,
      );
      return;
    }
    case "set-exploded":
      if (threeViewerRef) {
        applyExplodedView(getLoadedThreeViewer(), request.enabled);
      }
      return;
    case "get-components":
      if (threeViewerRef) {
        return { components: getLoadedThreeViewer().componentTree };
      }
      return { components: [] };
    case "set-component-visibility":
      if (threeViewerRef) {
        setThreeComponentVisibility(getLoadedThreeViewer(), request.componentId, request.visible);
      }
      return;
    case "zoom-to-fit":
      if (threeViewerRef) {
        zoomThreeViewerToFit(getLoadedThreeViewer());
        return;
      }
      zoomEmbeddedViewerToFit(getLoadedViewer().embeddedViewer);
      return;
    case "capture":
      return { pngBase64: await capturePngBase64(request) };
    case "destroy":
      destroyViewer();
      return;
  }
}

function isCadViewerFrameRequest(value: unknown): value is CadViewerFrameRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    (value as { source?: unknown }).source === CAD_VIEWER_FRAME_PARENT_SOURCE &&
    "requestId" in value &&
    typeof (value as { requestId?: unknown }).requestId === "string" &&
    "type" in value &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

window.addEventListener("message", (event) => {
  if (!isCadViewerFrameRequest(event.data)) {
    return;
  }

  const request = event.data;
  void handleRequest(request).then(
    (payload) => {
      postToParent({
        type: "response",
        requestId: request.requestId,
        ok: true,
        ...(payload ? { payload } : {}),
      });
    },
    (error) => {
      postToParent({
        type: "response",
        requestId: request.requestId,
        ok: false,
        error: errorMessage(error),
      });
    },
  );
});

const resizeObserver = new ResizeObserver(() => {
  if (resizeAnimationFrame !== 0) {
    return;
  }
  resizeAnimationFrame = requestAnimationFrame(() => {
    resizeAnimationFrame = 0;
    embeddedViewerRef?.Resize();
    if (threeViewerRef) {
      resizeThreeViewer(threeViewerRef);
    }
  });
});
resizeObserver.observe(root);

window.addEventListener("beforeunload", () => {
  resizeObserver.disconnect();
  destroyViewer();
});

postToParent({ type: "ready" });
