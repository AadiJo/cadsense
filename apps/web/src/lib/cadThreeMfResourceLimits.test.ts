import { describe, expect, it } from "vitest";
import { zipSync } from "three/examples/jsm/libs/fflate.module.js";

import {
  assertCadModelBuffersWithinLimit,
  inspectThreeMfArchive,
  loadCadModelResourcesWithinLimit,
  MAX_3MF_ARCHIVE_ENTRIES,
  MAX_3MF_EXPANDED_ENTRY_BYTES,
  readResponseArrayBufferWithinLimit,
  resolveCadModelBufferWithinLimit,
  unzipThreeMfWithinLimits,
} from "./cadThreeMfResourceLimits";

describe("3MF resource limits", () => {
  it("inspects and expands archives within the configured bounds", () => {
    const archive = zipSync({ "3D/model.model": new TextEncoder().encode("model") });

    expect(inspectThreeMfArchive(archive)).toEqual({ entries: 1, expandedBytes: 5 });
    expect(new TextDecoder().decode(unzipThreeMfWithinLimits(archive)["3D/model.model"])).toBe(
      "model",
    );
  });

  it("rejects archives with too many entries before expansion", () => {
    const files = Object.fromEntries(
      Array.from({ length: MAX_3MF_ARCHIVE_ENTRIES + 1 }, (_, index) => [
        `3D/${index}.model`,
        new Uint8Array(0),
      ]),
    );
    const archive = zipSync(files);

    expect(() => inspectThreeMfArchive(archive)).toThrow(/entry safety limit/);
  });

  it("rejects an archive entry larger than the expanded-size limit", () => {
    const archive = zipSync({ "3D/model.model": new Uint8Array(1) });
    const bytes = new Uint8Array(archive);
    const centralDirectorySignature = [0x50, 0x4b, 0x01, 0x02];
    const offset = bytes.findIndex((value, index) =>
      centralDirectorySignature.every(
        (signatureByte, delta) => bytes[index + delta] === signatureByte,
      ),
    );
    expect(offset).toBeGreaterThanOrEqual(0);
    const oversized = MAX_3MF_EXPANDED_ENTRY_BYTES + 1;
    new DataView(bytes.buffer).setUint32(offset + 24, oversized, true);

    expect(() => inspectThreeMfArchive(bytes)).toThrow(/entry.*safety limit/);
  });

  it("rejects a declared response length and cancels the body before reading it", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-length": "11" } },
    );

    await expect(readResponseArrayBufferWithinLimit(response, 10)).rejects.toThrow(
      /download.*safety limit/,
    );
    expect(cancelled).toBe(true);
  });

  it("stops streaming a response once the byte limit is crossed", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(6));
          controller.enqueue(new Uint8Array(5));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );

    await expect(readResponseArrayBufferWithinLimit(response, 10)).rejects.toThrow(
      /download.*safety limit/,
    );
    expect(cancelled).toBe(true);
  });

  it("reads a response without Content-Length when the stream remains within the limit", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 2]));
          controller.enqueue(Uint8Array.from([3, 4, 5]));
          controller.close();
        },
      }),
    );

    await expect(readResponseArrayBufferWithinLimit(response, 5)).resolves.toEqual(
      Uint8Array.from([1, 2, 3, 4, 5]).buffer,
    );
  });

  it("can enforce one shared byte budget across multiple response streams", async () => {
    const first = new Response(Uint8Array.from([1, 2, 3, 4, 5, 6]));
    let secondCancelled = false;
    const second = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([7, 8, 9, 10, 11]));
        },
        cancel() {
          secondCancelled = true;
        },
      }),
    );

    await expect(
      loadCadModelResourcesWithinLimit({
        items: [first, second],
        maximumBytes: 10,
        load: async (response, remainingBytes) => ({
          buffer: await readResponseArrayBufferWithinLimit(response, remainingBytes),
        }),
      }),
    ).rejects.toThrow(/download.*safety limit/);
    expect(secondCancelled).toBe(true);
  });

  it("enforces per-buffer and aggregate limits for materialized CAD payloads", () => {
    expect(() => assertCadModelBuffersWithinLimit([new ArrayBuffer(11)], 10)).toThrow(
      /model data.*safety limit/,
    );
    expect(() =>
      assertCadModelBuffersWithinLimit([new ArrayBuffer(6), new ArrayBuffer(5)], 10),
    ).toThrow(/model data.*safety limit/);
    expect(() =>
      assertCadModelBuffersWithinLimit([new ArrayBuffer(6), new ArrayBuffer(4)], 10),
    ).not.toThrow();
  });

  it("reuses a materialized CAD payload without loading a second full-size copy", async () => {
    const materializedBuffer = new ArrayBuffer(10);
    let loadCalls = 0;

    await expect(
      resolveCadModelBufferWithinLimit({
        materializedBuffer,
        maximumBytes: 10,
        load: async () => {
          loadCalls += 1;
          return new ArrayBuffer(10);
        },
      }),
    ).resolves.toBe(materializedBuffer);
    expect(loadCalls).toBe(0);

    await expect(
      resolveCadModelBufferWithinLimit({
        materializedBuffer: new ArrayBuffer(11),
        maximumBytes: 10,
        load: async () => new ArrayBuffer(0),
      }),
    ).rejects.toThrow(/model data.*safety limit/);
  });
});
