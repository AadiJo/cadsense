import type { CadView } from "@cadsense/contracts";

export const CAD_VIEWER_FRAME_PARENT_SOURCE = "cadsense-cad-viewer-parent";
export const CAD_VIEWER_FRAME_SOURCE = "cadsense-cad-viewer-frame";

export interface CadViewerFrameFilePayload {
  readonly name: string;
  readonly buffer: ArrayBuffer;
  readonly type?: string;
}

export interface CadViewerFrameFileDescriptor {
  readonly name: string;
  readonly url: string;
  readonly type?: string;
  readonly sizeBytes?: number;
}

export interface CadViewerFrameLoadStats {
  readonly strategy: "three-3mf-direct-url" | "online-3d-viewer-file-list";
  readonly bytes: number;
  readonly fetchMs: number;
  readonly importMs: number;
  readonly totalMs: number;
}

export type CadViewerFrameLoadStage =
  | "request-received"
  | "direct-3mf-imports-loaded"
  | "direct-3mf-archive-expanded"
  | "direct-3mf-fast-parsed"
  | "direct-3mf-model-parsed"
  | "direct-3mf-viewer-created"
  | "fallback-files-fetched"
  | "fallback-viewer-loaded";

export type CadViewerFrameRequestInput =
  | {
      readonly type: "load-files";
      readonly files: ReadonlyArray<CadViewerFrameFilePayload>;
    }
  | {
      readonly type: "load-file-urls";
      readonly files: ReadonlyArray<CadViewerFrameFileDescriptor>;
    }
  | {
      readonly type: "set-view";
      readonly view: CadView;
      readonly fit: boolean;
    }
  | {
      readonly type: "set-exploded";
      readonly enabled: boolean;
    }
  | {
      readonly type: "zoom-to-fit";
    }
  | {
      readonly type: "capture";
      readonly view?: CadView;
      readonly fit: boolean;
    }
  | {
      readonly type: "destroy";
    };

export type CadViewerFrameRequest = CadViewerFrameRequestInput & {
  readonly source: typeof CAD_VIEWER_FRAME_PARENT_SOURCE;
  readonly requestId: string;
};

export type CadViewerFrameResponse =
  | {
      readonly source: typeof CAD_VIEWER_FRAME_SOURCE;
      readonly type: "ready";
    }
  | {
      readonly source: typeof CAD_VIEWER_FRAME_SOURCE;
      readonly type: "status";
      readonly requestId: string;
      readonly stage: CadViewerFrameLoadStage;
      readonly elapsedMs: number;
    }
  | {
      readonly source: typeof CAD_VIEWER_FRAME_SOURCE;
      readonly type: "response";
      readonly requestId: string;
      readonly ok: true;
      readonly payload?: {
        readonly pngBase64?: string;
        readonly loadStats?: CadViewerFrameLoadStats;
      };
    }
  | {
      readonly source: typeof CAD_VIEWER_FRAME_SOURCE;
      readonly type: "response";
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
    };

export type CadViewerFrameResponseInput =
  | {
      readonly type: "ready";
    }
  | {
      readonly type: "status";
      readonly requestId: string;
      readonly stage: CadViewerFrameLoadStage;
      readonly elapsedMs: number;
    }
  | {
      readonly type: "response";
      readonly requestId: string;
      readonly ok: true;
      readonly payload?: {
        readonly pngBase64?: string;
        readonly loadStats?: CadViewerFrameLoadStats;
      };
    }
  | {
      readonly type: "response";
      readonly requestId: string;
      readonly ok: false;
      readonly error: string;
    };

export function isCadViewerFrameResponse(value: unknown): value is CadViewerFrameResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    (value as { source?: unknown }).source === CAD_VIEWER_FRAME_SOURCE
  );
}
