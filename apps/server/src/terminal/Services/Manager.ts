import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "@cadsense/contracts";
import { TerminalNotRunningError } from "@cadsense/contracts";

type TerminalOpenInputValue = Schema.Schema.Type<typeof TerminalOpenInput>;
type TerminalWriteInputValue = Schema.Schema.Type<typeof TerminalWriteInput>;
type TerminalResizeInputValue = Schema.Schema.Type<typeof TerminalResizeInput>;
type TerminalClearInputValue = Schema.Schema.Type<typeof TerminalClearInput>;
type TerminalRestartInputValue = Schema.Schema.Type<typeof TerminalRestartInput>;
type TerminalCloseInputValue = Schema.Schema.Type<typeof TerminalCloseInput>;
type TerminalSessionSnapshotValue = Schema.Schema.Type<typeof TerminalSessionSnapshot>;

export interface TerminalManagerShape {
  readonly open: (input: TerminalOpenInputValue) => Effect.Effect<TerminalSessionSnapshotValue>;
  readonly write: (input: TerminalWriteInputValue) => Effect.Effect<void, TerminalNotRunningError>;
  readonly resize: (
    input: TerminalResizeInputValue,
  ) => Effect.Effect<void, TerminalNotRunningError>;
  readonly clear: (input: TerminalClearInputValue) => Effect.Effect<void, TerminalNotRunningError>;
  readonly restart: (
    input: TerminalRestartInputValue,
  ) => Effect.Effect<TerminalSessionSnapshotValue>;
  readonly close: (input: TerminalCloseInputValue) => Effect.Effect<void>;
  readonly subscribe: (
    listener: (event: unknown) => Effect.Effect<unknown>,
  ) => Effect.Effect<() => void>;
}

export class TerminalManager extends Context.Service<TerminalManager, TerminalManagerShape>()(
  "cadsense/terminal/Services/Manager",
) {}

export const TerminalManagerDisabledLive = Layer.succeed(TerminalManager, {
  open: (input) =>
    Effect.succeed({
      threadId: input.threadId,
      terminalId: input.terminalId,
      status: "disabled",
    }),
  write: (input) =>
    Effect.fail(
      new TerminalNotRunningError({
        threadId: input.threadId,
        terminalId: input.terminalId,
      }),
    ),
  resize: (input) =>
    Effect.fail(
      new TerminalNotRunningError({
        threadId: input.threadId,
        terminalId: input.terminalId,
      }),
    ),
  clear: (input) =>
    Effect.fail(
      new TerminalNotRunningError({
        threadId: input.threadId,
        terminalId: input.terminalId,
      }),
    ),
  restart: (input) =>
    Effect.succeed({
      threadId: input.threadId,
      terminalId: input.terminalId,
      status: "disabled",
    }),
  close: () => Effect.void,
  subscribe: () => Effect.succeed(() => undefined),
} satisfies TerminalManagerShape);
