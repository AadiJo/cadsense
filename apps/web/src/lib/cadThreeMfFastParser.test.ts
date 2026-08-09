import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { zipSync, unzipSync } from "three/examples/jsm/libs/fflate.module.js";

import { getThreeMfRootModelByteLength, parseThreeMfFast } from "./cadThreeMfFastParser";

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
});
