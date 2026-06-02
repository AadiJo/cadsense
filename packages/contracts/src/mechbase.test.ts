import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import { MechbaseSetupConnectionInput, MechbaseSetupConnectionResult } from "./mechbase.ts";

const decodeMechbaseSetupConnectionInput = Schema.decodeUnknownSync(MechbaseSetupConnectionInput);
const decodeMechbaseSetupConnectionResult = Schema.decodeUnknownSync(MechbaseSetupConnectionResult);

describe("Mechbase setup contracts", () => {
  it("trims API keys before validation", () => {
    expect(decodeMechbaseSetupConnectionInput({ apiKey: "  mechbase-key  " })).toEqual({
      apiKey: "mechbase-key",
    });
  });

  it("rejects blank API keys after trimming", () => {
    expect(() => decodeMechbaseSetupConnectionInput({ apiKey: "   " })).toThrow();
  });

  it("decodes successful connection results", () => {
    expect(
      decodeMechbaseSetupConnectionResult({
        connection: {
          displayName: "Mechbase",
          apiKeyConfigured: true,
        },
      }),
    ).toEqual({
      connection: {
        displayName: "Mechbase",
        apiKeyConfigured: true,
      },
    });
  });
});
