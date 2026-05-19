import type {
  OnshapeConnection,
  OnshapeImportUrlInput,
  OnshapeIndexResult,
  OnshapeListConnectionsResult,
  OnshapeRefreshIndexInput,
  OnshapeSearchIndexInput,
  OnshapeSearchIndexResult,
  OnshapeSetupConnectionInput,
  OnshapeSyncProjectInput,
  OnshapeSyncProjectResult,
} from "@cadsense/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import type { HttpClientError } from "effect/unstable/http/HttpClientError";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { SecretStoreError } from "../../auth/Services/ServerSecretStore.ts";

export class OnshapeWorkspaceFailure extends Data.TaggedError("OnshapeWorkspaceFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type OnshapeWorkspaceError =
  | ProjectionRepositoryError
  | SecretStoreError
  | HttpClientError
  | OnshapeWorkspaceFailure;

export interface OnshapeWorkspaceShape {
  readonly listConnections: () => Effect.Effect<
    OnshapeListConnectionsResult,
    OnshapeWorkspaceError
  >;
  readonly setupConnection: (
    input: OnshapeSetupConnectionInput,
  ) => Effect.Effect<{ readonly connection: OnshapeConnection }, OnshapeWorkspaceError>;
  readonly importUrl: (
    input: OnshapeImportUrlInput,
  ) => Effect.Effect<OnshapeIndexResult, OnshapeWorkspaceError>;
  readonly refreshIndex: (
    input: OnshapeRefreshIndexInput,
  ) => Effect.Effect<OnshapeIndexResult, OnshapeWorkspaceError>;
  readonly searchIndex: (
    input: OnshapeSearchIndexInput,
  ) => Effect.Effect<OnshapeSearchIndexResult, OnshapeWorkspaceError>;
  readonly syncProject: (
    input: OnshapeSyncProjectInput,
  ) => Effect.Effect<OnshapeSyncProjectResult, OnshapeWorkspaceError>;
}

export class OnshapeWorkspace extends Context.Service<OnshapeWorkspace, OnshapeWorkspaceShape>()(
  "cadsense/onshape/Services/OnshapeWorkspace",
) {}
