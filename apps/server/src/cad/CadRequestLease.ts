import { randomUUID } from "node:crypto";

import type { CadRequestClaimResult } from "@cadsense/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

/** Short enough to reclaim a dead viewer well inside the 120 second screenshot request budget. */
export const CAD_REQUEST_LEASE_MS = 30_000;

export interface CadRequestLease {
  readonly responderId: string;
  readonly leaseId: string;
  readonly expiresAtMs: number;
  readonly attempt: number;
}

export interface CadRequestLeaseState {
  lease: CadRequestLease | undefined;
}

function formatInstant(epochMs: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(epochMs));
}

function currentTimeMillis(): number {
  return Effect.runSync(Clock.currentTimeMillis);
}

export function isCadRequestLeaseActive(
  lease: CadRequestLease | undefined,
  nowMs: number,
): boolean {
  return lease !== undefined && nowMs < lease.expiresAtMs;
}

/**
 * Atomically claims an in-memory pending request. Calling this again with the active responder id
 * renews the same lease, which lets a healthy viewer heartbeat while a model is still importing.
 * Once a lease expires, every new claim gets a new lease id so stale async work cannot finalize.
 */
export function claimCadRequestLease(
  state: CadRequestLeaseState,
  responderId: string,
  nowMs = currentTimeMillis(),
  makeLeaseId: () => string = randomUUID,
): CadRequestClaimResult {
  const current = state.lease;
  if (current !== undefined && isCadRequestLeaseActive(current, nowMs)) {
    if (current.responderId !== responderId) {
      return {
        status: "unavailable",
        reason: "already-claimed",
        retryAt: formatInstant(current.expiresAtMs),
      };
    }
    const renewed = { ...current, expiresAtMs: nowMs + CAD_REQUEST_LEASE_MS };
    state.lease = renewed;
    return {
      status: "claimed",
      leaseId: renewed.leaseId,
      leaseExpiresAt: formatInstant(renewed.expiresAtMs),
      attempt: renewed.attempt,
    };
  }

  const claimed: CadRequestLease = {
    responderId,
    leaseId: makeLeaseId(),
    expiresAtMs: nowMs + CAD_REQUEST_LEASE_MS,
    attempt: (current?.attempt ?? 0) + 1,
  };
  state.lease = claimed;
  return {
    status: "claimed",
    leaseId: claimed.leaseId,
    leaseExpiresAt: formatInstant(claimed.expiresAtMs),
    attempt: claimed.attempt,
  };
}

export function ownsCadRequestLease(
  state: CadRequestLeaseState,
  claim: { readonly responderId: string; readonly leaseId: string },
  nowMs = currentTimeMillis(),
): boolean {
  const lease = state.lease;
  return (
    lease !== undefined &&
    isCadRequestLeaseActive(lease, nowMs) &&
    lease.responderId === claim.responderId &&
    lease.leaseId === claim.leaseId
  );
}
