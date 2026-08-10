import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { zipSync, unzipSync } from "three/examples/jsm/libs/fflate.module.js";

import {
  buildThreeMfFastGroupResult,
  getThreeMfRootModelByteLength,
  parseThreeMfFast,
} from "./cadThreeMfFastParser";

const textEncoder = new TextEncoder();

function makeThreeMf(modelXml: string): Record<string, Uint8Array> {
  return unzipSync(
    zipSync({
      "_rels/.rels": textEncoder.encode(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
      ),
      "[Content_Types].xml": textEncoder.encode(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      ),
      "3D/3dmodel.model": textEncoder.encode(modelXml),
    }),
  );
}

describe("cadThreeMfFastParser", () => {
  it("parses namespace-qualified core model elements", () => {
    const unzipped = makeThreeMf(`<?xml version="1.0"?>
<c:model xmlns:c="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <c:resources>
    <c:object xmlns:c="https://example.com/shadowed-extension" id="decoy"><c:mesh><c:vertices><c:vertex x="bad" y="0" z="0"/></c:vertices></c:mesh></c:object>
    <c:object id="1" name="qualified"><c:mesh><c:vertices><c:vertex x="0" y="0" z="0"/><c:vertex x="1" y="0" z="0"/><c:vertex x="0" y="1" z="0"/></c:vertices><c:triangles><c:triangle v1="0" v2="1" v3="2"/></c:triangles></c:mesh></c:object>
  </c:resources>
  <c:build><c:item objectid="1"/></c:build>
</c:model>`);

    const group = parseThreeMfFast({ three: THREE, unzipped });

    expect(group.children).toHaveLength(1);
    expect(group.children[0]!.name).toBe("qualified");
  });

  it("ignores core-looking objects outside resources and in extension namespaces", () => {
    const unzipped = makeThreeMf(`<?xml version="1.0"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:ext="https://example.com/extension">
  <metadata><object id="decoy"><mesh><vertices><vertex x="bad" y="0" z="0"/></vertices></mesh></object></metadata>
  <resources>
    <ext:object id="extension-decoy"><ext:mesh><ext:vertices><ext:vertex x="bad" y="0" z="0"/></ext:vertices></ext:mesh></ext:object>
    <object xmlns="" id="undeclared-decoy"><mesh><vertices><vertex x="bad" y="0" z="0"/></vertices></mesh></object>
    <object xmlns="https://example.com/local-extension" id="local-decoy"><mesh><vertices><vertex x="bad" y="0" z="0"/></vertices></mesh></object>
    <object id="1" name="real"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>
  </resources>
  <build><item objectid="1"/></build>
</model>`);

    const group = parseThreeMfFast({ three: THREE, unzipped });

    expect(group.children).toHaveLength(1);
    expect(group.children[0]!.name).toBe("real");
  });

  it("rejects malformed, reserved, and undeclared namespace uses", () => {
    const invalidModels = [
      `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:xml="https://example.com/not-xml"/>`,
      `<model xmlns:="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"/>`,
      `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" rogue:value="x"/></resources></model>`,
      `<c:model xmlns:c="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><c:resources><c:object xmlns:c="" id="1"/></c:resources></c:model>`,
    ];

    for (const modelXml of invalidModels) {
      expect(() => parseThreeMfFast({ three: THREE, unzipped: makeThreeMf(modelXml) })).toThrow(
        /namespace/i,
      );
    }
  });

  it("validates XML characters and references in attributes and text nodes", () => {
    const invalidModels = [
      `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unused="&#xFFFE;"/>`,
      `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unused="${String.fromCodePoint(0xfffe)}"/>`,
      `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata>&bogus;</metadata></model>`,
      `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata>&#xFFFE;</metadata></model>`,
    ];

    for (const modelXml of invalidModels) {
      expect(() => parseThreeMfFast({ three: THREE, unzipped: makeThreeMf(modelXml) })).toThrow(
        /character|XML 1\.0/i,
      );
    }

    const invalidUtf8 = makeThreeMf(
      `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"/>`,
    );
    invalidUtf8["3D/3dmodel.model"] = Uint8Array.from([0x3c, 0x6d, 0x6f, 0x64, 0xc0, 0xaf, 0x3e]);
    expect(() => parseThreeMfFast({ three: THREE, unzipped: invalidUtf8 })).toThrow(/UTF-8/i);
  });

  it("normalizes raw XML line endings and attribute whitespace", () => {
    const unzipped = makeThreeMf(
      `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" name="line\r\nbreak"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`,
    );

    expect(parseThreeMfFast({ three: THREE, unzipped }).children[0]!.name).toBe("line break");
  });

  it("rejects invalid QNames, prefixed undeclaration, and duplicate expanded attributes", () => {
    const invalidModels = [
      `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><1object/></resources></model>`,
      `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:bad-prefix!="https://example.com/extension"/>`,
      `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:ext="https://example.com/extension"><resources xmlns:ext=""/></model>`,
      `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:a="https://example.com/shared" xmlns:b="https://example.com/shared" a:value="one" b:value="two"/>`,
      `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unused="&bogus;"/>`,
      `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unused="forbidden\u0000character"/>`,
    ];

    for (const modelXml of invalidModels) {
      expect(() => parseThreeMfFast({ three: THREE, unzipped: makeThreeMf(modelXml) })).toThrow(
        /(?:qualified|namespace|expanded name|character)/i,
      );
    }
  });

  it("returns an error when a parsed worker model has no renderable geometry", () => {
    const result = buildThreeMfFastGroupResult({
      three: THREE,
      model: { meshes: [], roots: [] },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/renderable mesh geometry/);
    }
  });

  it("loads an Onshape-style mesh through component and build transforms without DOM parsing", () => {
    const unzipped = makeThreeMf(`<?xml version="1.0" encoding="utf-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" unit="meter">
  <resources>
    <m:colorgroup id="1"><m:color color="#FF0000FF"/></m:colorgroup>
    <object id="1" name="plate" type="model" pid="1" pindex="0">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0" />
          <vertex x="1" y="0" z="0" />
          <vertex x="0" y="1" z="0" />
        </vertices>
        <triangles><triangle v1="0" v2="1" v3="2" /></triangles>
      </mesh>
    </object>
    <object id="2" type="model">
      <components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 2 0 0"/></components>
    </object>
  </resources>
  <build><item objectid="2"/></build>
</model>`);

    expect(getThreeMfRootModelByteLength(unzipped)).toBeGreaterThan(0);

    const group = parseThreeMfFast({ three: THREE, unzipped });
    const mesh = group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhongMaterial>;

    expect(group.children).toHaveLength(1);
    expect(mesh.name).toBe("plate");
    expect(mesh.position.x).toBeCloseTo(2);
    expect(mesh.geometry.getAttribute("position").count).toBe(3);
    expect(mesh.geometry.getIndex()?.count).toBe(3);
    expect(mesh.material.color.r).toBeCloseTo(1);
  });

  it("preserves translucent 3MF material alpha", () => {
    const unzipped = makeThreeMf(`<?xml version="1.0" encoding="utf-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" unit="meter">
  <resources>
    <m:colorgroup id="1"><m:color color="#33669980"/></m:colorgroup>
    <object id="1" name="window" type="model" pid="1" pindex="0">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0" />
          <vertex x="1" y="0" z="0" />
          <vertex x="0" y="1" z="0" />
        </vertices>
        <triangles><triangle v1="0" v2="1" v3="2" /></triangles>
      </mesh>
    </object>
  </resources>
  <build><item objectid="1"/></build>
</model>`);

    const group = parseThreeMfFast({ three: THREE, unzipped });
    const mesh = group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhongMaterial>;

    expect(mesh.material.transparent).toBe(true);
    expect(mesh.material.depthWrite).toBe(false);
    expect(mesh.material.opacity).toBeCloseTo(128 / 255);
  });

  it("parses vertex and triangle attributes independent of XML ordering", () => {
    const unzipped = makeThreeMf(`<?xml version="1.0" encoding="utf-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:ext="https://example.com/3mf-extension" unit="meter">
  <resources>
    <object name="reordered" type="model" id="1">
      <mesh>
        <vertices>
          <vertex ext:x="99" z="0" x="0" y="0" />
          <vertex y="0" z="0" x="1" />
          <vertex z="0" y="1" x="0" />
        </vertices>
        <triangles><triangle ext:v1="2" v3="2" v1="0" v2="1" /></triangles>
      </mesh>
    </object>
  </resources>
  <build><item objectid="1" /></build>
</model>`);

    const group = parseThreeMfFast({ three: THREE, unzipped });
    const mesh = group.children[0] as THREE.Mesh<THREE.BufferGeometry>;

    expect(mesh.geometry.getAttribute("position").array).toEqual(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    );
    expect(mesh.geometry.getIndex()?.array).toEqual(new Uint16Array([0, 1, 2]));
  });

  it("loads the root model declared by the package relationship", () => {
    const rootModel = `<?xml version="1.0" encoding="utf-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="meter">
  <resources>
    <object id="1" name="declared-root" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0" />
          <vertex x="1" y="0" z="0" />
          <vertex x="0" y="1" z="0" />
        </vertices>
        <triangles><triangle v1="0" v2="1" v3="2" /></triangles>
      </mesh>
    </object>
  </resources>
  <build><item objectid="1" /></build>
</model>`;
    const unzipped = unzipSync(
      zipSync({
        "3D/decoy.model": textEncoder.encode("<not-a-model />"),
        "_rels/.rels": textEncoder.encode(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships" xmlns:ext="https://example.com/relationships-extension"><Relationship ext:Target="/Models/decoy.model" ext:Type="https://example.com/decoy" Target="/Models/root.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" /></Relationships>`,
        ),
        "Models/root.model": textEncoder.encode(rootModel),
      }),
    );

    const group = parseThreeMfFast({ three: THREE, unzipped });

    expect(group.children).toHaveLength(1);
    expect(group.children[0]?.name).toBe("declared-root");
    expect(getThreeMfRootModelByteLength(unzipped)).toBe(textEncoder.encode(rootModel).byteLength);
  });

  it("rejects archives whose declared root model is missing", () => {
    const unzipped = unzipSync(
      zipSync({
        "_rels/.rels": textEncoder.encode(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/Models/missing.model" /></Relationships>`,
        ),
        "3D/decoy.model": textEncoder.encode("<model />"),
      }),
    );

    expect(() => parseThreeMfFast({ three: THREE, unzipped })).toThrow(
      /declared root model part 'Models\/missing\.model'/,
    );
  });

  it("decodes XML character references in geometry, names, and relationship targets", () => {
    const modelXml = `<?xml version="1.0" encoding="utf-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="meter">
  <resources>
    <object id="1" name="A &amp; B" type="model">
      <mesh>
        <vertices>
          <vertex x="&#48;" y="0" z="0" />
          <vertex x="&#x31;" y="0" z="0" />
          <vertex x="0" y="1" z="0" />
        </vertices>
        <triangles><triangle v1="0" v2="1" v3="2" /></triangles>
      </mesh>
    </object>
  </resources>
  <build><item objectid="1" /></build>
</model>`;
    const unzipped = unzipSync(
      zipSync({
        "_rels/.rels": textEncoder.encode(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/Models/root&#46;model" /></Relationships>`,
        ),
        "Models/root.model": textEncoder.encode(modelXml),
      }),
    );

    const group = parseThreeMfFast({ three: THREE, unzipped });

    expect(group.children[0]?.name).toBe("A & B");
    const mesh = group.children[0] as THREE.Mesh<THREE.BufferGeometry>;
    expect(mesh.geometry.getAttribute("position").array).toEqual(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    );
  });

  it("ignores relationships from extension namespaces", () => {
    const rootModel = makeThreeMf(`<?xml version="1.0" encoding="utf-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="1" name="root"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources>
  <build><item objectid="1"/></build>
</model>`)["3D/3dmodel.model"]!;
    const unzipped = unzipSync(
      zipSync({
        "_rels/.rels": textEncoder.encode(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships" xmlns:ext="https://example.com/extension"><ext:Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/decoy.model"/><Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model"/></Relationships>`,
        ),
        "3D/decoy.model": textEncoder.encode("<not-a-model />"),
        "3D/3dmodel.model": rootModel,
      }),
    );

    expect(parseThreeMfFast({ three: THREE, unzipped }).children[0]?.name).toBe("root");
  });

  it("ignores relationship and geometry decoys inside comments and CDATA", () => {
    const modelXml = `<?xml version="1.0" encoding="utf-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <!-- <object id="decoy"><mesh><vertices><vertex x="invalid" y="0" z="0"/></vertices></mesh></object> -->
  <![CDATA[<triangle v1="999" v2="999" v3="999"/>]]>
  <resources><object id="1" name="root"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources>
  <build><item objectid="1"/></build>
</model>`;
    const unzipped = unzipSync(
      zipSync({
        "_rels/.rels": textEncoder.encode(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><!-- <Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/missing.model"/> --><Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/root.model"/></Relationships>`,
        ),
        "3D/root.model": textEncoder.encode(modelXml),
      }),
    );

    expect(parseThreeMfFast({ three: THREE, unzipped }).children[0]?.name).toBe("root");
  });

  it("ignores relationship and geometry decoys inside processing instructions", () => {
    const modelXml = `<?xml version="1.0" encoding="utf-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="1" name="root"><mesh><vertices><?decoy <vertex x="invalid" y="0" z="0"/> ?><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources>
  <build><item objectid="1"/></build>
</model>`;
    const unzipped = unzipSync(
      zipSync({
        "_rels/.rels": textEncoder.encode(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><?decoy <Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/missing.model"/> ?><Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/root.model"/></Relationships>`,
        ),
        "3D/root.model": textEncoder.encode(modelXml),
      }),
    );

    expect(parseThreeMfFast({ three: THREE, unzipped }).children[0]?.name).toBe("root");
  });

  it("does not interpret comment markers inside processing instructions", () => {
    const unzipped = makeThreeMf(`<?xml version="1.0"?>
<?decoy <!-- ?>
<!-- an ordinary comment after the processing instruction -->
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources>
  <build><item objectid="1"/></build>
</model>`);

    expect(parseThreeMfFast({ three: THREE, unzipped }).children).toHaveLength(1);
  });

  it("resolves qualified package relationships without accepting nested namespace decoys", () => {
    const rootModel = `<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
    const unzipped = unzipSync(
      zipSync({
        "_rels/.rels": textEncoder.encode(
          `<r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships" xmlns:ext="https://example.com/extension"><ext:wrapper xmlns="https://example.com/extension"><Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/Models/nested-decoy.model"/></ext:wrapper><r:Relationship xmlns:r="https://example.com/rebound" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/Models/rebound-decoy.model"/><r:Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/Models/root.model"/></r:Relationships>`,
        ),
        "Models/root.model": textEncoder.encode(rootModel),
        "Models/nested-decoy.model": textEncoder.encode("<not-a-model/>"),
        "Models/rebound-decoy.model": textEncoder.encode("<not-a-model/>"),
      }),
    );

    expect(parseThreeMfFast({ three: THREE, unzipped }).children).toHaveLength(1);
  });

  it("rejects markup delimiters inside quoted attribute values", () => {
    const unzipped = makeThreeMf(`<?xml version="1.0"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="1"><mesh><vertices><vertex x="0<?decoy?>" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources>
  <build><item objectid="1"/></build>
</model>`);

    expect(() => parseThreeMfFast({ three: THREE, unzipped })).toThrow(
      /markup inside a tag or attribute value/i,
    );
  });

  it("rejects mismatched element nesting before scanning object bodies", () => {
    const unzipped = makeThreeMf(`<?xml version="1.0"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></resources></object>
  <build><item objectid="1"/></build>
</model>`);

    expect(() => parseThreeMfFast({ three: THREE, unzipped })).toThrow(/mismatched element tags/i);
  });

  it("rejects DTD declarations rather than interpreting custom entity markup", () => {
    const unzipped = makeThreeMf(`<?xml version="1.0"?>
<!DOCTYPE model [<!ENTITY decoy "<vertex x='0' y='0' z='0'/>">]>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources/></model>`);

    expect(() => parseThreeMfFast({ three: THREE, unzipped })).toThrow(
      /document type declarations are not supported/,
    );
  });

  it("rejects triangle indices outside the vertex buffer instead of narrowing them", () => {
    const unzipped = makeThreeMf(`<?xml version="1.0" encoding="utf-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="65538"/></triangles></mesh></object></resources>
  <build><item objectid="1"/></build>
</model>`);

    expect(() => parseThreeMfFast({ three: THREE, unzipped })).toThrow(
      /triangle that references an invalid vertex/,
    );
  });

  it("rejects coordinates that overflow the float32 geometry buffer", () => {
    const unzipped = makeThreeMf(`<?xml version="1.0" encoding="utf-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="1"><mesh><vertices><vertex x="3.5e38" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources>
  <build><item objectid="1"/></build>
</model>`);

    expect(() => parseThreeMfFast({ three: THREE, unzipped })).toThrow(
      /vertex with invalid coordinates/,
    );
  });

  it("rejects empty coordinates instead of coercing them to zero", () => {
    const unzipped = makeThreeMf(`<?xml version="1.0" encoding="utf-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="1"><mesh><vertices><vertex x="" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources>
  <build><item objectid="1"/></build>
</model>`);

    expect(() => parseThreeMfFast({ three: THREE, unzipped })).toThrow(
      /vertex with invalid coordinates/,
    );
  });

  it("does not read fake attributes embedded in quoted extension values", () => {
    const modelXml = `<?xml version="1.0" encoding="utf-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object note=' id="decoy"' id="1" name="quoted-attributes"><mesh note=">"><vertices><vertex note=' x="99" >' x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle note=' v1="2" >' v1="0" v2="1" v3="2"/></triangles></mesh></object></resources>
  <build><item note=' objectid="missing"' objectid="1"/></build>
</model>`;
    const unzipped = unzipSync(
      zipSync({
        "_rels/.rels": textEncoder.encode(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Note=' Target="/missing.model"' Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/root.model"/></Relationships>`,
        ),
        "3D/root.model": textEncoder.encode(modelXml),
      }),
    );

    const group = parseThreeMfFast({ three: THREE, unzipped });
    const mesh = group.children[0] as THREE.Mesh<THREE.BufferGeometry>;
    expect(mesh.name).toBe("quoted-attributes");
    expect(mesh.geometry.getAttribute("position").array).toEqual(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    );
    expect(mesh.geometry.getIndex()?.array).toEqual(new Uint16Array([0, 1, 2]));
  });

  it("removes comments and CDATA before rejecting real DTD declarations", () => {
    const unzipped = makeThreeMf(`<?xml version="1.0"?>
<!-- <!DOCTYPE model> --><![CDATA[<!DOCTYPE model>]]>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`);

    expect(parseThreeMfFast({ three: THREE, unzipped }).children).toHaveLength(1);
  });

  it("rejects invalid XML character references", () => {
    const unzipped = makeThreeMf(`<?xml version="1.0"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" name="bad&#1;"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`);

    expect(() => parseThreeMfFast({ three: THREE, unzipped })).toThrow(
      /invalid character reference/,
    );
  });

  it("rejects malformed transforms and degenerate triangles", () => {
    const invalidTransform = makeThreeMf(`<?xml version="1.0"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 nope"/></build></model>`);
    expect(() => parseThreeMfFast({ three: THREE, unzipped: invalidTransform })).toThrow(
      /invalid transform/,
    );

    const degenerateTriangle = makeThreeMf(`<?xml version="1.0"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="0" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`);
    expect(() => parseThreeMfFast({ three: THREE, unzipped: degenerateTriangle })).toThrow(
      /triangle that references an invalid vertex/,
    );
  });

  it("rejects cyclic and exponentially expanding component graphs", () => {
    const cyclic = makeThreeMf(`<?xml version="1.0"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1"><components><component objectid="2"/></components></object><object id="2"><components><component objectid="1"/></components></object></resources><build><item objectid="1"/></build></model>`);
    expect(() => parseThreeMfFast({ three: THREE, unzipped: cyclic })).toThrow(/contains a cycle/);

    const objects = [
      `<object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>`,
    ];
    for (let id = 2; id <= 18; id += 1) {
      objects.push(
        `<object id="${id}"><components><component objectid="${id - 1}"/><component objectid="${id - 1}"/></components></object>`,
      );
    }
    const expanding = makeThreeMf(`<?xml version="1.0"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objects.join("")}</resources><build><item objectid="18"/></build></model>`);
    expect(() => parseThreeMfFast({ three: THREE, unzipped: expanding })).toThrow(
      /too many scene nodes/,
    );
  });

  it("rejects duplicate attributes, object ids, and missing component references", () => {
    const duplicateAttribute = makeThreeMf(`<?xml version="1.0"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1"><mesh><vertices><vertex x="0" x="1" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`);
    expect(() => parseThreeMfFast({ three: THREE, unzipped: duplicateAttribute })).toThrow(
      /duplicate 'x' attribute/,
    );

    const duplicateObject = makeThreeMf(`<?xml version="1.0"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1"></object><object id="1"></object></resources></model>`);
    expect(() => parseThreeMfFast({ three: THREE, unzipped: duplicateObject })).toThrow(
      /duplicate object id/,
    );

    const missingReference = makeThreeMf(`<?xml version="1.0"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1"><components><component objectid="missing"/></components></object></resources><build><item objectid="1"/></build></model>`);
    expect(() => parseThreeMfFast({ three: THREE, unzipped: missingReference })).toThrow(
      /references missing object/,
    );
  });
});
