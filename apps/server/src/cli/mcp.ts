import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { runCadViewMcpServer } from "../cad/CadViewMcp.ts";
import { runMechbaseMcpServer } from "../mechbase/MechbaseMcp.ts";

const cadViewCommand = Command.make("cad-view", {}, () =>
  Effect.tryPromise(() => runCadViewMcpServer()).pipe(Effect.orDie),
).pipe(Command.withDescription("Run the CadSense CAD view MCP server over stdio."));

const mechbaseCommand = Command.make("mechbase", {}, () =>
  Effect.tryPromise(() => runMechbaseMcpServer()).pipe(Effect.orDie),
).pipe(Command.withDescription("Run the CadSense Mechbase MCP server over stdio."));

export const mcpCommand = Command.make("mcp").pipe(
  Command.withDescription("Run CadSense MCP servers."),
  Command.withSubcommands([cadViewCommand, mechbaseCommand]),
);
