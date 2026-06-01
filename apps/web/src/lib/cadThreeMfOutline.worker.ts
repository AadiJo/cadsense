import { unzipSync } from "three/examples/jsm/libs/fflate.module.js";

import {
  parseThreeMfOutlineModel,
  type CadThreeMfParsedOutlineModel,
} from "./cadThreeMfFastParser";

export type ThreeMfOutlineWorkerRequest = {
  readonly id: number;
  readonly buffer: ArrayBuffer;
  readonly edgeThresholdDegrees: number;
  readonly maxSegments: number;
  readonly maxTriangles: number;
};

export type ThreeMfOutlineWorkerResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly outline: CadThreeMfParsedOutlineModel;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: string;
    };

type WorkerSelf = {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ThreeMfOutlineWorkerRequest>) => void,
  ): void;
  postMessage(message: ThreeMfOutlineWorkerResponse, transfer?: Transferable[]): void;
};

const workerSelf = self as unknown as WorkerSelf;

function collectTransferables(model: CadThreeMfParsedOutlineModel): Transferable[] {
  return model.meshes.map((mesh) => mesh.edgePositions.buffer);
}

workerSelf.addEventListener("message", (event) => {
  try {
    const unzipped = unzipSync(new Uint8Array(event.data.buffer));
    const outline = parseThreeMfOutlineModel({
      unzipped,
      edgeThresholdDegrees: event.data.edgeThresholdDegrees,
      maxSegments: event.data.maxSegments,
      maxTriangles: event.data.maxTriangles,
    });
    workerSelf.postMessage(
      {
        id: event.data.id,
        ok: true,
        outline,
      },
      collectTransferables(outline),
    );
  } catch (error) {
    workerSelf.postMessage(
      {
        id: event.data.id,
        ok: false,
        error:
          error instanceof Error ? error.message : String(error || "Failed to build 3MF outline."),
      },
      [],
    );
  }
});
