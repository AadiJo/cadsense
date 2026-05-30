import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface TerminalManagerShape {
  readonly open: (input: any) => Effect.Effect<any, any>;
  readonly write: (input: any) => Effect.Effect<void, any>;
  readonly resize: (input: any) => Effect.Effect<void, any>;
  readonly clear: (input: any) => Effect.Effect<void, any>;
  readonly restart: (input: any) => Effect.Effect<any, any>;
  readonly close: (input: any) => Effect.Effect<void, any>;
  readonly subscribe: (
    listener: (event: unknown) => Effect.Effect<unknown>,
  ) => Effect.Effect<() => void>;
}

export class TerminalManager extends Context.Service<TerminalManager, TerminalManagerShape>()(
  "cadsense/terminal/Services/Manager",
) {}
