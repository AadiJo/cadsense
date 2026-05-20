declare module "three/examples/jsm/libs/fflate.module.js" {
  export function unzipSync(data: Uint8Array): Record<string, Uint8Array>;
  export function zipSync(data: Record<string, Uint8Array>): Uint8Array;
}
