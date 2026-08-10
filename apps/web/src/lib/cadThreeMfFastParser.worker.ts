import {
  parseThreeMfFastModel,
  type CadThreeMfParsedMesh,
  type CadThreeMfParsedModel,
} from "./cadThreeMfFastParser";
import { unzipThreeMfWithinLimits } from "./cadThreeMfResourceLimits";

type ParseRequest = {
  readonly id: number;
  readonly buffer: ArrayBuffer;
};

type ParseResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly model: CadThreeMfParsedModel;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: string;
    };

type WorkerSelf = {
  addEventListener(type: "message", listener: (event: MessageEvent<ParseRequest>) => void): void;
  postMessage(message: ParseResponse, transfer?: Transferable[]): void;
};

const workerSelf = self as unknown as WorkerSelf;

function collectTransferables(model: CadThreeMfParsedModel): Transferable[] {
  const transferables: Transferable[] = [];
  for (const mesh of model.meshes) {
    transferables.push(mesh.positions.buffer, mesh.indices.buffer);
  }
  return transferables;
}

workerSelf.addEventListener("message", (event) => {
  try {
    const unzipped = unzipThreeMfWithinLimits(new Uint8Array(event.data.buffer));
    const model = parseThreeMfFastModel({ unzipped });
    const response: ParseResponse = {
      id: event.data.id,
      ok: true,
      model,
    };
    workerSelf.postMessage(response, collectTransferables(model));
  } catch (error) {
    const response: ParseResponse = {
      id: event.data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error || "Failed to parse 3MF."),
    };
    workerSelf.postMessage(response, []);
  }
});

export type { CadThreeMfParsedMesh, ParseRequest, ParseResponse };
