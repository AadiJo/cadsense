import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const MechbaseConnection = Schema.Struct({
  displayName: Schema.Literal("Mechbase"),
  apiKeyConfigured: Schema.Boolean,
});
export type MechbaseConnection = typeof MechbaseConnection.Type;

export const MechbaseListConnectionsResult = Schema.Struct({
  connections: Schema.Array(MechbaseConnection),
});
export type MechbaseListConnectionsResult = typeof MechbaseListConnectionsResult.Type;

export const MechbaseSetupConnectionInput = Schema.Struct({
  apiKey: TrimmedNonEmptyString,
});
export type MechbaseSetupConnectionInput = typeof MechbaseSetupConnectionInput.Type;

export const MechbaseSetupConnectionResult = Schema.Struct({
  connection: MechbaseConnection,
});
export type MechbaseSetupConnectionResult = typeof MechbaseSetupConnectionResult.Type;

export class MechbaseRpcError extends Schema.TaggedErrorClass<MechbaseRpcError>()(
  "MechbaseRpcError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}
