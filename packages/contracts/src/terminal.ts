import * as Schema from "effect/Schema";

export const TerminalOpenInput = Schema.Struct({
  threadId: Schema.String,
  terminalId: Schema.String,
  cwd: Schema.optional(Schema.String),
  worktreePath: Schema.optional(Schema.NullOr(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  cols: Schema.optional(Schema.Number),
  rows: Schema.optional(Schema.Number),
});
export const TerminalWriteInput = Schema.Struct({
  threadId: Schema.String,
  terminalId: Schema.String,
  data: Schema.String,
});
export const TerminalResizeInput = Schema.Struct({
  threadId: Schema.String,
  terminalId: Schema.String,
  cols: Schema.Number,
  rows: Schema.Number,
});
export const TerminalClearInput = Schema.Struct({
  threadId: Schema.String,
  terminalId: Schema.String,
});
export const TerminalRestartInput = TerminalOpenInput;
export const TerminalCloseInput = Schema.Struct({
  threadId: Schema.String,
  terminalId: Schema.optional(Schema.String),
  deleteHistory: Schema.optional(Schema.Boolean),
});
export const TerminalSessionSnapshot = Schema.Struct({
  threadId: Schema.String,
  terminalId: Schema.String,
  status: Schema.String,
});

export type TerminalEvent = {
  readonly threadId: string;
  readonly terminalId: string;
  readonly type: string;
  readonly [key: string]: unknown;
};
export const TerminalEvent: Schema.Schema<TerminalEvent> = Schema.Record(
  Schema.String,
  Schema.Unknown,
) as unknown as Schema.Schema<TerminalEvent>;

export class TerminalNotRunningError extends Schema.TaggedErrorClass<TerminalNotRunningError>()(
  "TerminalNotRunningError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {}

export const TerminalError = Schema.Union([TerminalNotRunningError]);
