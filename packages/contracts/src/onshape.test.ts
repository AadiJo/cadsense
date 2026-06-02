import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  CadSetCameraInput,
  CadSetViewInput,
  CadScreenshotMcpCaptureInput,
  OnshapeImportUrlInput,
  OnshapeSearchIndexInput,
  OnshapeSetupConnectionInput,
} from "./onshape.ts";

const decodeCadSetCameraInput = Schema.decodeUnknownSync(CadSetCameraInput);
const decodeCadSetViewInput = Schema.decodeUnknownSync(CadSetViewInput);
const decodeCadScreenshotMcpCaptureInput = Schema.decodeUnknownSync(CadScreenshotMcpCaptureInput);
const decodeOnshapeImportUrlInput = Schema.decodeUnknownSync(OnshapeImportUrlInput);
const decodeOnshapeSearchIndexInput = Schema.decodeUnknownSync(OnshapeSearchIndexInput);
const decodeOnshapeSetupConnectionInput = Schema.decodeUnknownSync(OnshapeSetupConnectionInput);

describe("Onshape setup contracts", () => {
  it("trims user-entered connection credentials", () => {
    const decoded = decodeOnshapeSetupConnectionInput({
      displayName: "  Team Onshape  ",
      baseUrl: "  https://cad.onshape.com  ",
      accessKeyId: "  access-key  ",
      secretKey: "  secret-key  ",
    });

    expect(decoded).toMatchObject({
      displayName: "Team Onshape",
      baseUrl: "https://cad.onshape.com",
      accessKeyId: "access-key",
      secretKey: "secret-key",
    });
  });

  it("rejects blank secrets after trimming", () => {
    expect(() =>
      decodeOnshapeSetupConnectionInput({
        displayName: "Team Onshape",
        baseUrl: "https://cad.onshape.com",
        accessKeyId: "access-key",
        secretKey: "   ",
      }),
    ).toThrow();
  });
});

describe("Onshape CAD import/search contracts", () => {
  it("defaults import to documents-only unless parts are requested", () => {
    const decoded = decodeOnshapeImportUrlInput({
      connectionId: "team-onshape",
      url: " https://cad.onshape.com/documents/document-id/w/workspace-id/e/element-id ",
    });

    expect(decoded.includeParts).toBe(false);
    expect(decoded.url).toBe(
      "https://cad.onshape.com/documents/document-id/w/workspace-id/e/element-id",
    );
  });

  it("rejects search limits outside the supported page size", () => {
    expect(() =>
      decodeOnshapeSearchIndexInput({ connectionId: "team-onshape", query: "gearbox", limit: 0 }),
    ).toThrow();
    expect(() =>
      decodeOnshapeSearchIndexInput({ connectionId: "team-onshape", query: "gearbox", limit: 101 }),
    ).toThrow();
  });
});

describe("CAD viewer command contracts", () => {
  it("defaults set-view and screenshot capture requests to fit the model", () => {
    expect(decodeCadSetViewInput({ threadId: "thread-cad", view: "isometric" })).toMatchObject({
      threadId: "thread-cad",
      view: "isometric",
      fit: true,
    });
    expect(
      decodeCadScreenshotMcpCaptureInput({
        threadId: "thread-cad",
        exportRoot: "/tmp/cad-screenshots",
      }),
    ).toMatchObject({
      threadId: "thread-cad",
      exportRoot: "/tmp/cad-screenshots",
      fit: true,
    });
  });

  it("requires camera vectors to be exactly three numbers", () => {
    expect(() =>
      decodeCadSetCameraInput({
        threadId: "thread-cad",
        direction: [0, 1],
      }),
    ).toThrow();
    expect(() =>
      decodeCadSetCameraInput({
        threadId: "thread-cad",
        direction: [0, 1, 0],
        up: [0, 0, 1],
      }),
    ).not.toThrow();
  });
});
