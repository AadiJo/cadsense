import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";

import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { MECHBASE_API_KEY_SECRET_NAME, validateMechbaseApiKey } from "./MechbaseApi.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const MECHBASE_API_KEY_VALIDATION_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedApiKeyValidation: {
  readonly apiKey: string;
  readonly expiresAt: number;
} | null = null;

export function decodeMechbaseApiKey(value: Uint8Array): string {
  return textDecoder.decode(value).trim();
}

export function encodeMechbaseApiKey(value: string): Uint8Array {
  return textEncoder.encode(value.trim());
}

export function clearMechbaseApiKeyValidationCacheForTests(): void {
  cachedApiKeyValidation = null;
}

export function getCachedValidatedMechbaseApiKey(
  storedApiKey: Uint8Array,
  options?: {
    readonly now?: () => number;
    readonly validate?: (apiKey: string) => Promise<unknown>;
  },
) {
  return Effect.gen(function* () {
    const apiKey = decodeMechbaseApiKey(storedApiKey);
    const now = options?.now?.() ?? (yield* Clock.currentTimeMillis);
    if (
      cachedApiKeyValidation &&
      cachedApiKeyValidation.apiKey === apiKey &&
      cachedApiKeyValidation.expiresAt > now
    ) {
      return { apiKey };
    }

    const validate = options?.validate ?? validateMechbaseApiKey;
    yield* Effect.tryPromise(() => validate(apiKey));
    cachedApiKeyValidation = {
      apiKey,
      expiresAt: now + MECHBASE_API_KEY_VALIDATION_CACHE_TTL_MS,
    };
    return { apiKey };
  });
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
