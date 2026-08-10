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
  readonly a: number;
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

export interface CadThreeMfParsedOutlineMesh {
  readonly id: string;
  readonly name: string | null;
  readonly edgePositions: Float32Array;
}

export interface CadThreeMfParsedOutlineModel {
  readonly meshes: readonly CadThreeMfParsedOutlineMesh[];
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

const ROOT_RELATIONSHIPS_ENTRY = "_rels/.rels";
const ROOT_MODEL_RELATIONSHIP_TYPE = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";
const CORE_MODEL_NAMESPACE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const PACKAGE_RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const XML_ATTRIBUTE_TEXT = String.raw`(?:"[^"]*"|'[^']*'|[^'">])*`;
const RELATIONSHIP_PATTERN = new RegExp(
  `<(?:([a-z_][\\w.-]*):)?relationship\\b(${XML_ATTRIBUTE_TEXT})\\s*/?>`,
  "giu",
);
const OBJECT_PATTERN = new RegExp(
  `<object\\b(${XML_ATTRIBUTE_TEXT})>([\\s\\S]*?)<\\/object>`,
  "giu",
);
const COMPONENT_PATTERN = new RegExp(`<component\\b(${XML_ATTRIBUTE_TEXT})\\s*/?>`, "giu");
const ITEM_PATTERN = new RegExp(`<item\\b(${XML_ATTRIBUTE_TEXT})\\s*/?>`, "giu");
const COLOR_PATTERN = new RegExp(
  `<(?:[a-z_][\\w.-]*:)?color\\b(${XML_ATTRIBUTE_TEXT})\\s*/?>`,
  "giu",
);
const VERTEX_PATTERN = new RegExp(`<vertex\\b(${XML_ATTRIBUTE_TEXT})\\s*/?>`, "giu");
const TRIANGLE_PATTERN = new RegExp(`<triangle\\b(${XML_ATTRIBUTE_TEXT})\\s*/?>`, "giu");
const MAX_COMPONENT_NESTING_DEPTH = 512;
const MAX_EXPANDED_NODE_COUNT = 100_000;
const CORE_ELEMENT_PARENTS = new Map<string, string>([
  ["resources", "model"],
  ["object", "resources"],
  ["mesh", "object"],
  ["components", "object"],
  ["vertices", "mesh"],
  ["triangles", "mesh"],
  ["vertex", "vertices"],
  ["triangle", "triangles"],
  ["component", "components"],
  ["build", "model"],
  ["item", "build"],
]);
const RELATIONSHIP_ELEMENT_PARENTS = new Map<string, string>([["Relationship", "Relationships"]]);

function structuralXml(source: string): string {
  let structural = "";
  let cursor = 0;
  const openTags: string[] = [];
  const appendCharacterData = (value: string): void => {
    if (value.includes("]]>")) {
      throw new Error("3MF XML contains an unterminated comment or CDATA section.");
    }
    structural += value;
  };
  while (cursor < source.length) {
    const markupStart = source.indexOf("<", cursor);
    if (markupStart < 0) {
      appendCharacterData(source.slice(cursor));
      break;
    }
    appendCharacterData(source.slice(cursor, markupStart));

    if (source.startsWith("<!--", markupStart)) {
      const end = source.indexOf("-->", markupStart + 4);
      if (end < 0) {
        throw new Error("3MF XML contains an unterminated comment or CDATA section.");
      }
      const body = source.slice(markupStart + 4, end);
      if (body.includes("--") || body.endsWith("-")) {
        throw new Error("3MF XML contains a malformed comment.");
      }
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", markupStart)) {
      const end = source.indexOf("]]>", markupStart + 9);
      if (end < 0) {
        throw new Error("3MF XML contains an unterminated comment or CDATA section.");
      }
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<?", markupStart)) {
      const end = source.indexOf("?>", markupStart + 2);
      if (end < 0) {
        throw new Error("3MF XML contains an unterminated processing instruction.");
      }
      cursor = end + 2;
      continue;
    }
    if (source.slice(markupStart).match(/^<!DOCTYPE\b/iu)) {
      throw new Error("3MF XML document type declarations are not supported.");
    }
    if (source.startsWith("<!", markupStart)) {
      throw new Error("3MF XML contains an unsupported markup declaration.");
    }

    let tagCursor = markupStart + 1;
    let quote: '"' | "'" | null = null;
    for (; tagCursor < source.length; tagCursor += 1) {
      const character = source[tagCursor]!;
      if (character === "<") {
        throw new Error("3MF XML contains markup inside a tag or attribute value.");
      }
      if (quote !== null) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === ">") break;
    }
    if (tagCursor >= source.length || quote !== null) {
      throw new Error("3MF XML contains an unterminated tag or attribute value.");
    }
    const tag = source.slice(markupStart, tagCursor + 1);
    const tagBody = tag.slice(1, -1);
    const closingMatch = /^\/([^\s/<>"'=]+)\s*$/u.exec(tagBody);
    if (closingMatch) {
      const name = closingMatch[1]!;
      if (openTags.pop() !== name) {
        throw new Error("3MF XML contains mismatched element tags.");
      }
    } else {
      const openingMatch = /^([^\s/<>"'=]+)(?:\s[\s\S]*|\/\s*)?$/u.exec(tagBody);
      if (!openingMatch) {
        throw new Error("3MF XML contains a malformed element tag.");
      }
      if (!/\/\s*$/u.test(tagBody)) {
        openTags.push(openingMatch[1]!);
      }
    }
    structural += tag;
    cursor = tagCursor + 1;
  }
  if (openTags.length > 0) {
    throw new Error("3MF XML contains an unterminated element tag.");
  }
  return structural;
}

interface XmlAttribute {
  readonly name: string;
  readonly value: string;
}

function parseXmlAttributes(source: string): XmlAttribute[] {
  const attributes: XmlAttribute[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (cursor >= source.length || source[cursor] === "/") break;

    const nameStart = cursor;
    while (cursor < source.length && !/[\s=]/u.test(source[cursor]!)) cursor += 1;
    const name = source.slice(nameStart, cursor);
    if (!name || /[\x2f<>'"]/u.test(name)) {
      throw new Error("3MF XML contains a malformed attribute name.");
    }
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== "=") {
      throw new Error("3MF XML contains an attribute without a value.");
    }
    cursor += 1;
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") {
      throw new Error("3MF XML contains an unquoted attribute value.");
    }
    cursor += 1;
    const valueStart = cursor;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd < 0) {
      throw new Error("3MF XML contains an unterminated attribute value.");
    }
    attributes.push({ name, value: source.slice(valueStart, valueEnd) });
    cursor = valueEnd + 1;
    if (cursor < source.length && !/\s|\//u.test(source[cursor]!)) {
      throw new Error("3MF XML attributes must be separated by whitespace.");
    }
  }
  return attributes;
}

interface ModelElementFrame {
  readonly emittedName: string;
  readonly localName: string;
  readonly namespaceChanges: readonly NamespaceChange[];
}

interface NamespaceChange {
  readonly prefix: string;
  readonly previousValue?: string;
}

function normalizeNamespacedElements(input: {
  readonly source: string;
  readonly namespace: string;
  readonly rootLocalName: string;
  readonly elementParents: ReadonlyMap<string, string>;
}): string {
  const { source } = input;
  const elementParentsByLowercase = new Map(
    Array.from(input.elementParents, ([localName, parentName]) => [
      localName.toLowerCase(),
      { localName, parentName },
    ]),
  );
  let normalized = "";
  let cursor = 0;
  let sawRoot = false;
  const frames: ModelElementFrame[] = [];
  const namespaces = new Map<string, string>([["xml", XML_NAMESPACE]]);
  const restoreNamespaces = (changes: readonly NamespaceChange[]): void => {
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      const change = changes[index]!;
      if (change.previousValue === undefined) {
        namespaces.delete(change.prefix);
      } else {
        namespaces.set(change.prefix, change.previousValue);
      }
    }
  };

  while (cursor < source.length) {
    const tagStart = source.indexOf("<", cursor);
    if (tagStart < 0) {
      normalized += source.slice(cursor);
      break;
    }
    normalized += source.slice(cursor, tagStart);
    let tagEnd = tagStart + 1;
    let quote: '"' | "'" | null = null;
    for (; tagEnd < source.length; tagEnd += 1) {
      const character = source[tagEnd]!;
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (tagEnd >= source.length) {
      throw new Error("3MF XML contains an unterminated element tag.");
    }

    const tagBody = source.slice(tagStart + 1, tagEnd);
    if (tagBody.startsWith("/")) {
      const frame = frames.pop();
      if (!frame) {
        throw new Error("3MF XML contains mismatched element tags.");
      }
      normalized += `</${frame.emittedName}>`;
      restoreNamespaces(frame.namespaceChanges);
      cursor = tagEnd + 1;
      continue;
    }

    const selfClosing = /\/\s*$/u.test(tagBody);
    const openingBody = selfClosing ? tagBody.replace(/\/\s*$/u, "") : tagBody;
    const openingMatch = /^([^\s/<>'"=]+)([\s\S]*)$/u.exec(openingBody);
    if (!openingMatch) {
      throw new Error("3MF XML contains a malformed element tag.");
    }
    const qualifiedName = openingMatch[1]!;
    const nameParts = qualifiedName.split(":");
    if (nameParts.length > 2 || nameParts.some((part) => part.length === 0)) {
      throw new Error("3MF XML contains a malformed qualified element name.");
    }
    const prefix = nameParts.length === 2 ? nameParts[0]! : "";
    const localName = nameParts.at(-1)!;
    const attributesSource = openingMatch[2]!;
    const namespaceChanges: NamespaceChange[] = [];
    const declaredPrefixes = new Set<string>();
    const attributes = parseXmlAttributes(attributesSource);
    for (const attribute of attributes) {
      let declaredPrefix: string | null = null;
      if (attribute.name === "xmlns") {
        declaredPrefix = "";
      } else if (attribute.name.startsWith("xmlns:")) {
        declaredPrefix = attribute.name.slice("xmlns:".length);
      }
      if (declaredPrefix !== null) {
        if (!declaredPrefix && attribute.name !== "xmlns") {
          throw new Error("3MF XML contains a malformed namespace declaration.");
        }
        if (declaredPrefix.includes(":")) {
          throw new Error("3MF XML contains a malformed namespace prefix.");
        }
        if (declaredPrefixes.has(declaredPrefix)) {
          throw new Error("3MF XML contains a duplicate namespace declaration.");
        }
        declaredPrefixes.add(declaredPrefix);
        const namespaceValue = decodeXmlAttributeValue(attribute.value);
        if (
          declaredPrefix === "xmlns" ||
          namespaceValue === XMLNS_NAMESPACE ||
          (declaredPrefix === "xml" && namespaceValue !== XML_NAMESPACE) ||
          (declaredPrefix !== "xml" && namespaceValue === XML_NAMESPACE)
        ) {
          throw new Error("3MF XML contains an invalid reserved namespace declaration.");
        }
        namespaceChanges.push({
          prefix: declaredPrefix,
          ...(namespaces.has(declaredPrefix)
            ? { previousValue: namespaces.get(declaredPrefix)! }
            : {}),
        });
        if (namespaceValue === "") {
          namespaces.delete(declaredPrefix);
        } else {
          namespaces.set(declaredPrefix, namespaceValue);
        }
      }
    }
    for (const attribute of attributes) {
      if (attribute.name === "xmlns" || attribute.name.startsWith("xmlns:")) {
        continue;
      }
      const attributeNameParts = attribute.name.split(":");
      if (attributeNameParts.length > 2 || attributeNameParts.some((part) => part.length === 0)) {
        throw new Error("3MF XML contains a malformed qualified attribute name.");
      }
      const attributePrefix = attributeNameParts.length === 2 ? attributeNameParts[0]! : "";
      if (attributePrefix && !namespaces.has(attributePrefix)) {
        throw new Error(
          `3MF XML attribute '${attribute.name}' uses an undeclared namespace prefix.`,
        );
      }
    }
    const namespace = namespaces.get(prefix) ?? null;
    if (prefix && namespace === null) {
      throw new Error(`3MF XML element '${qualifiedName}' uses an undeclared namespace prefix.`);
    }

    const parentName = frames.at(-1)?.localName ?? null;
    if (!sawRoot) {
      sawRoot = true;
      if (localName !== input.rootLocalName || namespace !== input.namespace) {
        throw new Error("3MF root element is not in the expected XML namespace.");
      }
    } else if (frames.length === 0) {
      throw new Error("3MF XML contains more than one document element.");
    }

    const elementRule = elementParentsByLowercase.get(localName.toLowerCase());
    const isExpectedElement = namespace === input.namespace;
    const validContext =
      elementRule !== undefined &&
      localName === elementRule.localName &&
      parentName === elementRule.parentName;
    const emittedName = elementRule
      ? isExpectedElement && validContext
        ? localName
        : `ignored:${localName}`
      : isExpectedElement
        ? localName
        : qualifiedName;
    normalized += `<${emittedName}${attributesSource}${selfClosing ? "/" : ""}>`;
    if (selfClosing) {
      restoreNamespaces(namespaceChanges);
    } else {
      frames.push({ emittedName, localName: emittedName, namespaceChanges });
    }
    cursor = tagEnd + 1;
  }
  return normalized;
}

function normalizeCoreModelElements(source: string): string {
  return normalizeNamespacedElements({
    source,
    namespace: CORE_MODEL_NAMESPACE,
    rootLocalName: "model",
    elementParents: CORE_ELEMENT_PARENTS,
  });
}

function normalizePackageRelationshipsElements(source: string): string {
  return normalizeNamespacedElements({
    source,
    namespace: PACKAGE_RELATIONSHIPS_NAMESPACE,
    rootLocalName: "Relationships",
    elementParents: RELATIONSHIP_ELEMENT_PARENTS,
  });
}

function decodeXmlAttributeValue(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\dA-Fa-f]+);)/u.test(value)) {
    throw new Error("3MF XML attribute contains an invalid character reference.");
  }
  return value.replace(
    /&(amp|lt|gt|quot|apos|#(\d+)|#x([\dA-Fa-f]+));/gu,
    (_reference, entity: string, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal !== undefined || hexadecimal !== undefined) {
        const codePoint = Number.parseInt(decimal ?? hexadecimal!, decimal === undefined ? 16 : 10);
        if (
          !Number.isSafeInteger(codePoint) ||
          (codePoint !== 0x9 && codePoint !== 0xa && codePoint !== 0xd && codePoint < 0x20) ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
          codePoint === 0xfffe ||
          codePoint === 0xffff
        ) {
          throw new Error("3MF XML attribute contains an invalid character reference.");
        }
        return String.fromCodePoint(codePoint);
      }
      switch (entity.toLowerCase()) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        default:
          return "";
      }
    },
  );
}

function getAttribute(source: string, name: string): string | null {
  const expectedName = name.toLowerCase();
  let matchedValue: string | undefined;
  for (const attribute of parseXmlAttributes(source)) {
    if (attribute.name.toLowerCase() === expectedName) {
      if (matchedValue !== undefined) {
        throw new Error(`3MF XML contains a duplicate '${name}' attribute.`);
      }
      matchedValue = decodeXmlAttributeValue(attribute.value);
    }
  }
  return matchedValue ?? null;
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
  const a = hex.length >= 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

function parseTransform(value: string | null): readonly number[] | null {
  if (value === null) {
    return null;
  }
  const parts = value.trim().split(/\s+/u);
  const decimalPattern = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/iu;
  const numbers = parts.map((part) =>
    decimalPattern.test(part) ? Math.fround(Number(part)) : NaN,
  );
  if (numbers.length !== 12 || !numbers.every(Number.isFinite)) {
    throw new Error("3MF component or build item contains an invalid transform.");
  }
  return numbers;
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

function countParsedTags<T>(
  pattern: RegExp,
  source: string,
  parse: (attributes: string) => T | null,
): number {
  pattern.lastIndex = 0;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (parse(match[1]!) !== null) {
      count += 1;
    }
  }
  pattern.lastIndex = 0;
  return count;
}

function countTags(pattern: RegExp, source: string): number {
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
    const value = getAttribute(match[1]!, "color");
    if (value && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value)) {
      colors.push(parseColor(value));
    }
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
    if (objects.has(id)) {
      throw new Error(`3MF resources contain duplicate object id '${id}'.`);
    }
    const meshMatch = new RegExp(`<mesh\\b${XML_ATTRIBUTE_TEXT}>([\\s\\S]*?)<\\/mesh>`, "iu").exec(
      body,
    );
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
  const buildMatch = new RegExp(`<build\\b${XML_ATTRIBUTE_TEXT}>([\\s\\S]*?)<\\/build>`, "iu").exec(
    modelXml,
  );
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
  const parseVertex = (attributes: string): readonly [number, number, number] | null => {
    const parseCoordinate = (name: string): number => {
      const value = getAttribute(attributes, name);
      if (value === null || value.trim().length === 0) {
        return Number.NaN;
      }
      const parsed = Number(value);
      const stored = Math.fround(parsed);
      return Number.isFinite(stored) ? stored : Number.NaN;
    };
    const x = parseCoordinate("x");
    const y = parseCoordinate("y");
    const z = parseCoordinate("z");
    return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? [x, y, z] : null;
  };
  const parseTriangle = (attributes: string): readonly [number, number, number] | null => {
    const parseIndex = (name: string): number => {
      const value = getAttribute(attributes, name);
      return value !== null && /^\d+$/u.test(value) ? Number.parseInt(value, 10) : -1;
    };
    const v1 = parseIndex("v1");
    const v2 = parseIndex("v2");
    const v3 = parseIndex("v3");
    return [v1, v2, v3].every((index) => Number.isSafeInteger(index) && index >= 0)
      ? [v1, v2, v3]
      : null;
  };

  const vertexCount = countParsedTags(VERTEX_PATTERN, meshBlock, parseVertex);
  if (vertexCount !== countTags(VERTEX_PATTERN, meshBlock)) {
    throw new Error("3MF mesh contains a vertex with invalid coordinates.");
  }
  const parseBoundedTriangle = (attributes: string): readonly [number, number, number] | null => {
    const triangle = parseTriangle(attributes);
    return triangle?.every((index) => index < vertexCount) && new Set(triangle).size === 3
      ? triangle
      : null;
  };
  const triangleCount = countParsedTags(TRIANGLE_PATTERN, meshBlock, parseBoundedTriangle);
  if (triangleCount !== countTags(TRIANGLE_PATTERN, meshBlock)) {
    throw new Error("3MF mesh contains a triangle that references an invalid vertex.");
  }
  if (vertexCount === 0 || triangleCount === 0) {
    throw new Error("3MF mesh did not contain renderable triangle geometry.");
  }
  const positions = new Float32Array(vertexCount * 3);
  const indices =
    vertexCount > 65_535 ? new Uint32Array(triangleCount * 3) : new Uint16Array(triangleCount * 3);

  VERTEX_PATTERN.lastIndex = 0;
  let vertexIndex = 0;
  let vertexMatch: RegExpExecArray | null;
  while ((vertexMatch = VERTEX_PATTERN.exec(meshBlock)) !== null) {
    const coordinates = parseVertex(vertexMatch[1]!);
    if (!coordinates) {
      continue;
    }
    const base = vertexIndex * 3;
    positions[base] = coordinates[0];
    positions[base + 1] = coordinates[1];
    positions[base + 2] = coordinates[2];
    vertexIndex += 1;
  }
  VERTEX_PATTERN.lastIndex = 0;

  TRIANGLE_PATTERN.lastIndex = 0;
  let triangleIndex = 0;
  let triangleMatch: RegExpExecArray | null;
  while ((triangleMatch = TRIANGLE_PATTERN.exec(meshBlock)) !== null) {
    const triangle = parseBoundedTriangle(triangleMatch[1]!);
    if (!triangle) {
      continue;
    }
    const base = triangleIndex * 3;
    indices[base] = triangle[0];
    indices[base + 1] = triangle[1];
    indices[base + 2] = triangle[2];
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
    opacity: color?.a ?? 1,
    transparent: color !== null && color.a < 1,
    depthWrite: color === null || color.a >= 1,
    side: three.DoubleSide,
  });
}

function normalizeRootPartTarget(target: string): string {
  const withoutQueryOrFragment = target.split(/[?#]/u, 1)[0] ?? "";
  let decodedTarget: string;
  try {
    decodedTarget = decodeURIComponent(withoutQueryOrFragment);
  } catch {
    throw new Error("3MF root model relationship contains invalid percent encoding.");
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(decodedTarget) || decodedTarget.startsWith("//")) {
    throw new Error("3MF root model relationship must target a package part.");
  }
  if (/[\\\u0000-\u001f\u007f]/u.test(decodedTarget)) {
    throw new Error("3MF root model relationship contains invalid package path characters.");
  }

  const segments: string[] = [];
  for (const segment of decodedTarget.replace(/^\/+/, "").split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error("3MF root model relationship escapes the package root.");
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new Error("3MF root model relationship did not name a model part.");
  }
  return segments.join("/");
}

function findRootModelXml(unzipped: Record<string, Uint8Array>): Uint8Array {
  const relationshipsEntryName = Object.keys(unzipped).find(
    (name) => name.replace(/^\/+/, "").toLowerCase() === ROOT_RELATIONSHIPS_ENTRY,
  );
  const relationshipsBytes = relationshipsEntryName ? unzipped[relationshipsEntryName] : undefined;
  if (!relationshipsBytes) {
    throw new Error("3MF archive did not contain package root relationships.");
  }

  const relationshipsXml = normalizePackageRelationshipsElements(
    structuralXml(new TextDecoder().decode(relationshipsBytes)),
  );
  RELATIONSHIP_PATTERN.lastIndex = 0;
  let relationshipMatch: RegExpExecArray | null;
  let rootPartName: string | null = null;
  while ((relationshipMatch = RELATIONSHIP_PATTERN.exec(relationshipsXml)) !== null) {
    const prefix = relationshipMatch[1];
    const attributes = relationshipMatch[2]!;
    if (prefix !== undefined) {
      continue;
    }
    if (getAttribute(attributes, "Type") !== ROOT_MODEL_RELATIONSHIP_TYPE) {
      continue;
    }
    if (getAttribute(attributes, "TargetMode")?.toLowerCase() === "external") {
      throw new Error("3MF root model relationship cannot target an external resource.");
    }
    const target = getAttribute(attributes, "Target");
    if (!target) {
      throw new Error("3MF root model relationship did not include a target.");
    }
    rootPartName = normalizeRootPartTarget(target);
    break;
  }
  RELATIONSHIP_PATTERN.lastIndex = 0;
  if (!rootPartName) {
    throw new Error("3MF archive did not declare a root 3D model relationship.");
  }

  const entryName = Object.keys(unzipped).find((name) => name.replace(/^\/+/, "") === rootPartName);
  const entry = entryName ? unzipped[entryName] : undefined;
  if (!entry) {
    throw new Error(`3MF archive did not contain declared root model part '${rootPartName}'.`);
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
  const modelXml = normalizeCoreModelElements(structuralXml(new TextDecoder().decode(modelBytes)));
  const colors = parseColors(modelXml);
  const objects = parseObjects(modelXml);
  const buildItems = parseBuildItems(modelXml);
  const parsedMeshes = new Map<string, CadThreeMfParsedMesh>();
  let expandedNodeCount = 0;

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
      throw new Error("3MF component graph contains a cycle.");
    }
    const object = objects.get(objectId);
    if (!object) {
      throw new Error(`3MF component or build item references missing object '${objectId}'.`);
    }
    if (stack.size >= MAX_COMPONENT_NESTING_DEPTH) {
      throw new Error("3MF component graph exceeds the supported nesting depth.");
    }
    expandedNodeCount += 1;
    if (expandedNodeCount > MAX_EXPANDED_NODE_COUNT) {
      throw new Error("3MF component graph expands to too many scene nodes.");
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

type EdgeRecord = {
  readonly key: string;
  readonly a: number;
  readonly b: number;
  readonly normal: readonly [number, number, number];
  visible: boolean;
};

function edgeKey(left: number, right: number): string {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

function vertexAt(positions: Float32Array, index: number): readonly [number, number, number] {
  const offset = index * 3;
  return [positions[offset] ?? 0, positions[offset + 1] ?? 0, positions[offset + 2] ?? 0];
}

function triangleNormal(
  positions: Float32Array,
  aIndex: number,
  bIndex: number,
  cIndex: number,
): readonly [number, number, number] {
  const a = vertexAt(positions, aIndex);
  const b = vertexAt(positions, bIndex);
  const c = vertexAt(positions, cIndex);
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const length = Math.hypot(nx, ny, nz);
  return length > 0 ? [nx / length, ny / length, nz / length] : [0, 0, 0];
}

function normalDot(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function markOutlineEdge(
  edges: Map<string, EdgeRecord>,
  a: number,
  b: number,
  normal: readonly [number, number, number],
  sharpEdgeCosine: number,
): void {
  const key = edgeKey(a, b);
  const existing = edges.get(key);
  if (!existing) {
    edges.set(key, { key, a, b, normal, visible: true });
    return;
  }
  existing.visible = normalDot(existing.normal, normal) <= sharpEdgeCosine;
}

function buildOutlineMesh(input: {
  readonly mesh: CadThreeMfParsedMesh;
  readonly edgeThresholdDegrees: number;
  readonly maxSegments: number;
  readonly maxTriangles: number;
}): CadThreeMfParsedOutlineMesh {
  const edges = new Map<string, EdgeRecord>();
  const triangleCount = Math.min(
    Math.floor(input.mesh.indices.length / 3),
    Math.max(0, input.maxTriangles),
  );
  const edgeThresholdRadians = (Math.max(0, input.edgeThresholdDegrees) * Math.PI) / 180;
  const sharpEdgeCosine = Math.cos(edgeThresholdRadians);

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const offset = triangleIndex * 3;
    const a = input.mesh.indices[offset] ?? 0;
    const b = input.mesh.indices[offset + 1] ?? 0;
    const c = input.mesh.indices[offset + 2] ?? 0;
    const normal = triangleNormal(input.mesh.positions, a, b, c);
    markOutlineEdge(edges, a, b, normal, sharpEdgeCosine);
    markOutlineEdge(edges, b, c, normal, sharpEdgeCosine);
    markOutlineEdge(edges, c, a, normal, sharpEdgeCosine);
  }

  const visibleEdges = Array.from(edges.values())
    .filter((edge) => edge.visible)
    .slice(0, Math.max(0, input.maxSegments));
  const edgePositions = new Float32Array(visibleEdges.length * 6);
  visibleEdges.forEach((edge, edgeIndex) => {
    const a = vertexAt(input.mesh.positions, edge.a);
    const b = vertexAt(input.mesh.positions, edge.b);
    edgePositions.set([...a, ...b], edgeIndex * 6);
  });
  return {
    id: input.mesh.id,
    name: input.mesh.name,
    edgePositions,
  };
}

export function parseThreeMfOutlineModel(input: {
  readonly unzipped: Record<string, Uint8Array>;
  readonly edgeThresholdDegrees: number;
  readonly maxSegments: number;
  readonly maxTriangles: number;
}): CadThreeMfParsedOutlineModel {
  const model = parseThreeMfFastModel({ unzipped: input.unzipped });
  return {
    meshes: model.meshes.map((mesh) =>
      buildOutlineMesh({
        mesh,
        edgeThresholdDegrees: input.edgeThresholdDegrees,
        maxSegments: input.maxSegments,
        maxTriangles: input.maxTriangles,
      }),
    ),
  };
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

export type CadThreeMfFastGroupBuildResult =
  | { readonly ok: true; readonly group: ThreeGroup }
  | { readonly ok: false; readonly error: Error };

export function buildThreeMfFastGroupResult(input: {
  readonly three: ThreeModule;
  readonly model: CadThreeMfParsedModel;
}): CadThreeMfFastGroupBuildResult {
  try {
    return { ok: true, group: buildThreeMfFastGroup(input) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
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
