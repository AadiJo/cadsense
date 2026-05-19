import {
  OnshapeConnection,
  OnshapeConnectionId,
  OnshapeEntity,
  OnshapeEntityId,
  OnshapeIndexRun,
  OnshapeThreadContext,
  ThreadId,
} from "@cadsense/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const PersistedOnshapeConnection = Schema.Struct({
  ...OnshapeConnection.fields,
  secretKeyCiphertext: Schema.String,
});
export type PersistedOnshapeConnection = typeof PersistedOnshapeConnection.Type;

export interface OnshapeIndexRepositoryShape {
  readonly upsertConnection: (
    connection: PersistedOnshapeConnection,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listConnections: () => Effect.Effect<
    ReadonlyArray<PersistedOnshapeConnection>,
    ProjectionRepositoryError
  >;
  readonly getConnection: (
    connectionId: OnshapeConnectionId,
  ) => Effect.Effect<Option.Option<PersistedOnshapeConnection>, ProjectionRepositoryError>;
  readonly upsertIndexRun: (run: OnshapeIndexRun) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getLatestIndexRun: (
    connectionId: OnshapeConnectionId,
  ) => Effect.Effect<Option.Option<OnshapeIndexRun>, ProjectionRepositoryError>;
  readonly upsertEntities: (
    entities: ReadonlyArray<OnshapeEntity>,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly searchEntities: (input: {
    readonly connectionId?: OnshapeConnectionId;
    readonly query: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<OnshapeEntity>, ProjectionRepositoryError>;
  readonly getEntity: (
    entityId: OnshapeEntityId,
  ) => Effect.Effect<Option.Option<OnshapeEntity>, ProjectionRepositoryError>;
  readonly upsertThreadContext: (
    context: OnshapeThreadContext,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getThreadContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OnshapeThreadContext>, ProjectionRepositoryError>;
}

export class OnshapeIndexRepository extends Context.Service<
  OnshapeIndexRepository,
  OnshapeIndexRepositoryShape
>()("cadsense/persistence/Services/OnshapeIndex/OnshapeIndexRepository") {}
