import * as Effect from "effect/Effect";

import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { MECHBASE_API_KEY_SECRET_NAME, validateMechbaseApiKey } from "./MechbaseApi.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export function decodeMechbaseApiKey(value: Uint8Array): string {
  return textDecoder.decode(value).trim();
}

export function encodeMechbaseApiKey(value: string): Uint8Array {
  return textEncoder.encode(value.trim());
}

export function getValidatedMechbaseApiKey() {
  return Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore;
    const stored = yield* secretStore.get(MECHBASE_API_KEY_SECRET_NAME);
    if (stored === null) {
      return null;
    }
    const apiKey = decodeMechbaseApiKey(stored);
    const validation = yield* Effect.tryPromise(() => validateMechbaseApiKey(apiKey));
    return { apiKey, validation };
  }).pipe(Effect.provide(ServerSecretStoreLive));
}
