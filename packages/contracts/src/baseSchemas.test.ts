import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { IsoDateTime } from "./baseSchemas.ts";

const decodeIsoDateTime = Schema.decodeUnknownSync(IsoDateTime);

describe("IsoDateTime", () => {
  it("accepts normalized ISO date-time strings with explicit timezones", () => {
    expect(decodeIsoDateTime("2026-06-02T21:34:56.789Z")).toBe("2026-06-02T21:34:56.789Z");
    expect(decodeIsoDateTime("2026-06-02T21:34:56-05:00")).toBe("2026-06-02T21:34:56-05:00");
  });

  it("rejects strings that do not preserve ISO date-time ordering semantics", () => {
    expect(() => decodeIsoDateTime("2026-06-02")).toThrow();
    expect(() => decodeIsoDateTime("not-a-date")).toThrow();
    expect(() => decodeIsoDateTime("2026-06-02T21:34:56")).toThrow();
  });
});
