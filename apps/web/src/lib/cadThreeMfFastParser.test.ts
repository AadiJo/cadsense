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
});
