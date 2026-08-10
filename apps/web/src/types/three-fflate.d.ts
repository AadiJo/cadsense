declare module "three/examples/jsm/libs/fflate.module.js" {
  interface UnzipFileInfo {
    readonly name: string;
    readonly size: number;
    readonly originalSize: number;
    readonly compression: number;
  }

  export function unzipSync(
    data: Uint8Array,
    options?: { readonly filter?: (file: UnzipFileInfo) => boolean },
  ): Record<string, Uint8Array>;
  export function zipSync(data: Record<string, Uint8Array>): Uint8Array;
}
