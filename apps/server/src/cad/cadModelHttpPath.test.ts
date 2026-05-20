import { describe, expect, it } from "vitest";

import { buildCadModelUrl, parseCadModelLeafFromPathname } from "./cadModelHttpPath.ts";

describe("cadModelHttpPath", () => {
  it("preserves the CAD extension in the path and appends an optional cache version", () => {
    const url = buildCadModelUrl("C:\\workspace\\Robot", "onshape-sync/current.3mf", "44-123");

    expect(url).toBe(
      "/api/onshape/cad-model/current.3mf?cwd=C%3A%5Cworkspace%5CRobot&path=onshape-sync%2Fcurrent.3mf&v=44-123",
    );
  });

  it("parses the extension-carrying leaf from the CAD route", () => {
    expect(parseCadModelLeafFromPathname("/api/onshape/cad-model/current.3mf")).toBe("current.3mf");
  });
});
