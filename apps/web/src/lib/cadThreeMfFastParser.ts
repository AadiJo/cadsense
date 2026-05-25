import type * as ThreeNamespace from "three";

type ThreeModule = typeof ThreeNamespace;
type ThreeGroup = ThreeNamespace.Group;
type ThreeMatrix4 = ThreeNamespace.Matrix4;
type ThreeBufferGeometry = ThreeNamespace.BufferGeometry;
type ThreeMaterial = ThreeNamespace.Material;

export interface ParsedColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface CadThreeMfParsedMesh {
  readonly id: string;
  readonly name: string | null;
  readonly color: ParsedColor | null;
  readonly positions: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
}

export interface CadThreeMfParsedNode {
  readonly kind: "group" | "mesh";
  readonly name: string | null;
  readonly transform: readonly number[] | null;
  readonly meshId?: string;
  readonly children?: readonly CadThreeMfParsedNode[];
}

export interface CadThreeMfParsedModel {
  readonly meshes: readonly CadThreeMfParsedMesh[];
  readonly roots: readonly CadThreeMfParsedNode[];
}

interface ParsedComponent {
  readonly objectId: string;
  readonly transform: readonly number[] | null;
}

interface ParsedObject {
  readonly id: string;
  readonly name: string | null;
  readonly pindex: number | null;
  readonly meshBlock: string | null;
  readonly components: readonly ParsedComponent[];
}

interface ParsedBuildItem {
  readonly objectId: string;
  readonly transform: readonly number[] | null;
}

const MODEL_ENTRY_PATTERN = /^3D\/[^/]*\.model$/u;
const OBJECT_PATTERN = /<object\b([^>]*)>([\s\S]*?)<\/object>/giu;
const COMPONENT_PATTERN = /<component\b([^>]*)\/?>/giu;
const ITEM_PATTERN = /<item\b([^>]*)\/?>/giu;
const COLOR_PATTERN = /<m:color\b[^>]*\bcolor="(#[0-9a-f]{6})(?:[0-9a-f]{2})?"[^>]*\/?>/giu;
const VERTEX_PATTERN =
  /<vertex\b[^>]*\bx="([^"]+)"[^>]*\by="([^"]+)"[^>]*\bz="([^"]+)"[^>]*\/?>/giu;
const TRIANGLE_PATTERN =
  /<triangle\b[^>]*\bv1="(\d+)"[^>]*\bv2="(\d+)"[^>]*\bv3="(\d+)"[^>]*\/?>/giu;

function getAttribute(source: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "iu").exec(source);
  return match?.[1] ?? null;
}

function parseOptionalInteger(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseColor(value: string): ParsedColor {
  const hex = value.startsWith("#") ? value.slice(1) : value;
  const r = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const g = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const b = Number.parseInt(hex.slice(4, 6), 16) / 255;
  return { r, g, b };
}

function parseTransform(value: string | null): readonly number[] | null {
  if (!value) {
    return null;
  }
  const numbers = value
    .trim()
    .split(/\s+/u)
    .map((part) => Number(part));
  return numbers.length >= 12 && numbers.every(Number.isFinite) ? numbers.slice(0, 12) : null;
}

function matrixFrom3mfTransform(
  three: ThreeModule,
  transform: readonly number[] | null,
): ThreeMatrix4 {
  const matrix = new three.Matrix4();
  if (!transform) {
    return matrix;
  }
  matrix.set(
    transform[0] ?? 1,
    transform[3] ?? 0,
    transform[6] ?? 0,
    transform[9] ?? 0,
    transform[1] ?? 0,
    transform[4] ?? 1,
    transform[7] ?? 0,
    transform[10] ?? 0,
    transform[2] ?? 0,
    transform[5] ?? 0,
    transform[8] ?? 1,
    transform[11] ?? 0,
    0,
    0,
    0,
    1,
  );
  return matrix;
}

function countMatches(pattern: RegExp, source: string): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(source) !== null) {
    count += 1;
  }
  pattern.lastIndex = 0;
  return count;
}

function parseColors(modelXml: string): ParsedColor[] {
  const colors: ParsedColor[] = [];
  COLOR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COLOR_PATTERN.exec(modelXml)) !== null) {
    colors.push(parseColor(match[1]!));
  }
  COLOR_PATTERN.lastIndex = 0;
  return colors;
}

function parseComponents(objectBody: string): ParsedComponent[] {
  const components: ParsedComponent[] = [];
  COMPONENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COMPONENT_PATTERN.exec(objectBody)) !== null) {
    const attributes = match[1]!;
    const objectId = getAttribute(attributes, "objectid");
    if (!objectId) {
      continue;
    }
    components.push({
      objectId,
      transform: parseTransform(getAttribute(attributes, "transform")),
    });
  }
  COMPONENT_PATTERN.lastIndex = 0;
  return components;
}

function parseObjects(modelXml: string): Map<string, ParsedObject> {
  const objects = new Map<string, ParsedObject>();
  OBJECT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OBJECT_PATTERN.exec(modelXml)) !== null) {
    const attributes = match[1]!;
    const body = match[2]!;
    const id = getAttribute(attributes, "id");
    if (!id) {
      continue;
    }
    const meshMatch = /<mesh\b[^>]*>([\s\S]*?)<\/mesh>/iu.exec(body);
    objects.set(id, {
      id,
      name: getAttribute(attributes, "name"),
      pindex: parseOptionalInteger(getAttribute(attributes, "pindex")),
      meshBlock: meshMatch?.[1] ?? null,
      components: parseComponents(body),
    });
  }
  OBJECT_PATTERN.lastIndex = 0;
  return objects;
}

function parseBuildItems(modelXml: string): ParsedBuildItem[] {
  const buildMatch = /<build\b[^>]*>([\s\S]*?)<\/build>/iu.exec(modelXml);
  if (!buildMatch) {
    return [];
  }

  const items: ParsedBuildItem[] = [];
  const buildBody = buildMatch[1]!;
  ITEM_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ITEM_PATTERN.exec(buildBody)) !== null) {
    const attributes = match[1]!;
    const objectId = getAttribute(attributes, "objectid");
    if (!objectId) {
      continue;
    }
    items.push({
      objectId,
      transform: parseTransform(getAttribute(attributes, "transform")),
    });
  }
  ITEM_PATTERN.lastIndex = 0;
  return items;
}

function parseGeometryData(meshBlock: string): Pick<CadThreeMfParsedMesh, "indices" | "positions"> {
  const vertexCount = countMatches(VERTEX_PATTERN, meshBlock);
  const triangleCount = countMatches(TRIANGLE_PATTERN, meshBlock);
  const positions = new Float32Array(vertexCount * 3);
  const indices =
    vertexCount > 65_535 ? new Uint32Array(triangleCount * 3) : new Uint16Array(triangleCount * 3);

  VERTEX_PATTERN.lastIndex = 0;
  let vertexIndex = 0;
  let vertexMatch: RegExpExecArray | null;
  while ((vertexMatch = VERTEX_PATTERN.exec(meshBlock)) !== null) {
    const base = vertexIndex * 3;
    positions[base] = Number(vertexMatch[1]);
    positions[base + 1] = Number(vertexMatch[2]);
    positions[base + 2] = Number(vertexMatch[3]);
    vertexIndex += 1;
  }
  VERTEX_PATTERN.lastIndex = 0;

  TRIANGLE_PATTERN.lastIndex = 0;
  let triangleIndex = 0;
  let triangleMatch: RegExpExecArray | null;
  while ((triangleMatch = TRIANGLE_PATTERN.exec(meshBlock)) !== null) {
    const base = triangleIndex * 3;
    indices[base] = Number.parseInt(triangleMatch[1]!, 10);
    indices[base + 1] = Number.parseInt(triangleMatch[2]!, 10);
    indices[base + 2] = Number.parseInt(triangleMatch[3]!, 10);
    triangleIndex += 1;
  }
  TRIANGLE_PATTERN.lastIndex = 0;

  return { positions, indices };
}

function geometryForParsedMesh(
  three: ThreeModule,
  mesh: Pick<CadThreeMfParsedMesh, "indices" | "positions">,
): ThreeBufferGeometry {
  const geometry = new three.BufferGeometry();
  geometry.setAttribute("position", new three.BufferAttribute(mesh.positions, 3));
  geometry.setIndex(new three.BufferAttribute(mesh.indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

function colorForObject(object: ParsedObject, colors: readonly ParsedColor[]): ParsedColor | null {
  return object.pindex === null ? null : (colors[object.pindex] ?? null);
}

function materialForParsedMesh(
  three: ThreeModule,
  mesh: Pick<CadThreeMfParsedMesh, "color">,
): ThreeMaterial {
  const color = mesh.color;
  return new three.MeshPhongMaterial({
    color: color ? new three.Color(color.r, color.g, color.b) : new three.Color(0x8f969d),
    side: three.DoubleSide,
  });
}

function findRootModelXml(unzipped: Record<string, Uint8Array>): Uint8Array {
  const entryName = Object.keys(unzipped).find((name) => MODEL_ENTRY_PATTERN.test(name));
  const entry = entryName ? unzipped[entryName] : undefined;
  if (!entry) {
    throw new Error("3MF archive did not contain a root 3D model part.");
  }
  return entry;
}

export function getThreeMfRootModelByteLength(unzipped: Record<string, Uint8Array>): number | null {
  return findRootModelXml(unzipped).byteLength;
}

export function parseThreeMfFastModel(input: {
  readonly unzipped: Record<string, Uint8Array>;
}): CadThreeMfParsedModel {
  const modelBytes = findRootModelXml(input.unzipped);
  const modelXml = new TextDecoder().decode(modelBytes);
  const colors = parseColors(modelXml);
  const objects = parseObjects(modelXml);
  const buildItems = parseBuildItems(modelXml);
  const parsedMeshes = new Map<string, CadThreeMfParsedMesh>();

  const getParsedMesh = (object: ParsedObject): CadThreeMfParsedMesh | null => {
    if (!object.meshBlock) {
      return null;
    }
    const existing = parsedMeshes.get(object.id);
    if (existing) {
      return existing;
    }
    const geometry = parseGeometryData(object.meshBlock);
    const built = {
      id: object.id,
      name: object.name,
      color: colorForObject(object, colors),
      ...geometry,
    } satisfies CadThreeMfParsedMesh;
    parsedMeshes.set(object.id, built);
    return built;
  };

  const buildNode = (
    objectId: string,
    transform: readonly number[] | null,
    stack: Set<string>,
  ): CadThreeMfParsedNode | null => {
    if (stack.has(objectId)) {
      return null;
    }
    const object = objects.get(objectId);
    if (!object) {
      return null;
    }

    const mesh = getParsedMesh(object);
    if (mesh) {
      return {
        kind: "mesh",
        name: mesh.name,
        transform,
        meshId: mesh.id,
      };
    }

    stack.add(objectId);
    const children: CadThreeMfParsedNode[] = [];
    for (const component of object.components) {
      const child = buildNode(component.objectId, component.transform, stack);
      if (child) {
        children.push(child);
      }
    }
    stack.delete(objectId);
    if (!object.name && children.length === 1 && !transform) {
      return children[0]!;
    }
    return children.length > 0
      ? {
          kind: "group",
          name: object.name,
          transform,
          children,
        }
      : null;
  };

  const roots =
    buildItems.length > 0
      ? buildItems
      : Array.from(objects.values())
          .filter((object) => object.meshBlock)
          .map((object) => ({ objectId: object.id, transform: null }));

  const rootNodes: CadThreeMfParsedNode[] = [];
  for (const item of roots) {
    const child = buildNode(item.objectId, item.transform, new Set());
    if (child) {
      rootNodes.push(child);
    }
  }

  if (rootNodes.length === 0) {
    throw new Error("3MF model did not contain renderable mesh geometry.");
  }

  return { meshes: Array.from(parsedMeshes.values()), roots: rootNodes };
}

export function buildThreeMfFastGroup(input: {
  readonly three: ThreeModule;
  readonly model: CadThreeMfParsedModel;
}): ThreeGroup {
  const { three } = input;
  const meshDataById = new Map(input.model.meshes.map((mesh) => [mesh.id, mesh]));
  const geometryById = new Map<string, ThreeBufferGeometry>();
  const materialById = new Map<string, ThreeMaterial>();
  const group = new three.Group();

  const getGeometry = (mesh: CadThreeMfParsedMesh): ThreeBufferGeometry => {
    const existing = geometryById.get(mesh.id);
    if (existing) {
      return existing;
    }
    const geometry = geometryForParsedMesh(three, mesh);
    geometryById.set(mesh.id, geometry);
    return geometry;
  };

  const getMaterial = (mesh: CadThreeMfParsedMesh): ThreeMaterial => {
    const existing = materialById.get(mesh.id);
    if (existing) {
      return existing;
    }
    const material = materialForParsedMesh(three, mesh);
    materialById.set(mesh.id, material);
    return material;
  };

  const buildObject = (node: CadThreeMfParsedNode): ThreeNamespace.Object3D | null => {
    if (node.kind === "mesh") {
      const meshData = node.meshId ? meshDataById.get(node.meshId) : undefined;
      if (!meshData) {
        return null;
      }
      const mesh = new three.Mesh(getGeometry(meshData), getMaterial(meshData));
      mesh.name = node.name ?? "";
      mesh.applyMatrix4(matrixFrom3mfTransform(three, node.transform));
      return mesh;
    }

    const assembly = new three.Group();
    assembly.name = node.name ?? "";
    assembly.applyMatrix4(matrixFrom3mfTransform(three, node.transform));
    for (const childNode of node.children ?? []) {
      const child = buildObject(childNode);
      if (child) {
        assembly.add(child);
      }
    }
    return assembly.children.length > 0 ? assembly : null;
  };

  for (const root of input.model.roots) {
    const child = buildObject(root);
    if (child) {
      group.add(child);
    }
  }

  if (group.children.length === 0) {
    for (const geometry of geometryById.values()) {
      geometry.dispose();
    }
    for (const material of materialById.values()) {
      material.dispose();
    }
    throw new Error("3MF model did not contain renderable mesh geometry.");
  }

  return group;
}

export function parseThreeMfFast(input: {
  readonly three: ThreeModule;
  readonly unzipped: Record<string, Uint8Array>;
}): ThreeGroup {
  return buildThreeMfFastGroup({
    three: input.three,
    model: parseThreeMfFastModel({ unzipped: input.unzipped }),
  });
}
