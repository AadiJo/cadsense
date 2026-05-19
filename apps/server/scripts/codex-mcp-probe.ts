#!/usr/bin/env bun
// @effect-diagnostics globalConsole:off
// @effect-diagnostics globalConsoleInEffect:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalErrorInEffectFailure:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
/**
 * Live probe: spawn `codex app-server`, attach the same `cadsense-cad-view` MCP
 * server CadSense wires up at runtime, send a turn, and assert codex stays alive
 * long enough to produce an assistant message.
 *
 * Reproduces / verifies the fix for the bug where the MCP env block sent to
 * codex did not carry `ELECTRON_RUN_AS_NODE=1`. With desktop builds, that
 * caused Electron (used as the MCP child binary) to start as a GUI app and
 * exit immediately; codex's rmcp transport then logged
 * `EOF while parsing a value at line 1 column 0` and the whole codex session
 * tore down before the assistant could reply.
 *
 * Usage:
 *   bun run scripts/codex-mcp-probe.ts                  — bun-spawns-codex sanity
 *   bun run scripts/codex-mcp-probe.ts --simulate-electron
 *     Sets `ELECTRON_RUN_AS_NODE=1` in `process.env` before computing the
 *     MCP env, then asserts the resulting env block carries the flag through
 *     to codex (so the desktop spawn would not crash).
 *
 * Exits 0 on success, non-zero with a printed reason on failure.
 */
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as CodexClient from "effect-codex-app-server/client";

import {
  CAD_VIEW_MCP_SERVER_NAME,
  makeCadViewMcpEnv,
  runCadViewMcpServer,
} from "../src/cad/CadViewMcp.ts";

if (process.argv.includes("--mcp-child")) {
  await runCadViewMcpServer();
  process.exit(0);
}

interface ProbeOptions {
  readonly simulateElectron: boolean;
  readonly skipTurn: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): ProbeOptions {
  return {
    simulateElectron: argv.includes("--simulate-electron"),
    skipTurn: argv.includes("--skip-turn"),
  };
}

interface StderrLine {
  readonly at: number;
  readonly line: string;
}

const DEFAULT_PORT = 13773;
const PROMPT = "What MCP servers do you have access to? Answer in one short sentence.";

const program = Effect.gen(function* () {
  const options = parseArgs(process.argv.slice(2));
  if (options.simulateElectron) {
    process.env.ELECTRON_RUN_AS_NODE = "1";
  }

  const config = { host: "127.0.0.1", port: DEFAULT_PORT };

  const env = makeCadViewMcpEnv(config, undefined, undefined);
  console.log("[probe] computed cadsense-cad-view MCP env keys:", Object.keys(env));
  if (options.simulateElectron && env.ELECTRON_RUN_AS_NODE !== "1") {
    console.error(
      "[probe] FAIL: ELECTRON_RUN_AS_NODE missing from MCP env block under --simulate-electron.",
    );
    process.exit(1);
  }
  if (options.simulateElectron) {
    console.log(
      "[probe] OK: ELECTRON_RUN_AS_NODE=1 is forwarded to the MCP child env (desktop spawn would survive).",
    );
  }

  // Build an MCP config that points back at THIS probe script so we can
  // exercise the cadsense-cad-view stdio server end-to-end. `--mcp-child` makes
  // the probe delegate to `runCadViewMcpServer()` at the top of this file
  // before any of the test orchestration runs.
  const probeScript = path.resolve(import.meta.dirname, "codex-mcp-probe.ts");
  const mcpConfig = {
    mcp_servers: {
      [CAD_VIEW_MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [probeScript, "--mcp-child"],
        env,
      },
    },
  };
  console.log("[probe] codex thread/start config:", JSON.stringify(mcpConfig));

  const codexBin = process.env.CODEX_BIN ?? "codex";
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  console.log(`[probe] spawning ${codexBin} app-server...`);
  const child = yield* spawner.spawn(
    ChildProcess.make(codexBin, ["app-server"], {
      cwd: process.cwd(),
      forceKillAfter: "2 seconds",
      shell: process.platform === "win32",
    }),
  );

  const stderrBuffer = yield* Ref.make<Array<StderrLine>>([]);
  const childExited = yield* Ref.make(false);
  const remainder = yield* Ref.make("");

  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.modify(remainder, (current) => {
        const combined = current + chunk;
        const lines = combined.split("\n");
        const tail = lines.pop() ?? "";
        return [lines, tail] as const;
      }).pipe(
        Effect.flatMap((lines) =>
          Effect.forEach(
            lines,
            (rawLine) => {
              const line = rawLine.replace(/\r$/, "").trim();
              if (line.length === 0) return Effect.void;
              console.log("[codex stderr]", line);
              return Ref.update(stderrBuffer, (buf) => [...buf, { at: Date.now(), line }]);
            },
            { discard: true },
          ),
        ),
      ),
    ),
    Effect.forkChild,
  );

  yield* child.exitCode.pipe(
    Effect.tap(() => Effect.sync(() => console.log("[probe] codex exited"))),
    Effect.tap(() => Ref.set(childExited, true)),
    Effect.forkChild,
  );

  const work = Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;

    const turnQueue = yield* Queue.unbounded<{
      readonly status: string;
      readonly errorMessage?: string;
    }>();
    const messages = yield* Ref.make<Array<string>>([]);
    const mcpStatuses = yield* Ref.make<Array<{ name: string; status: string }>>([]);

    yield* client.handleServerNotification("turn/completed", (payload) =>
      Queue.offer(turnQueue, {
        status: payload.turn.status,
        ...("error" in payload.turn && payload.turn.error
          ? { errorMessage: payload.turn.error.message }
          : {}),
      }).pipe(Effect.asVoid),
    );

    yield* client.handleServerNotification("item/completed", (payload) => {
      const item = payload.item as { readonly type: string; readonly text?: string };
      if (item.type === "agentMessage" && typeof item.text === "string") {
        return Ref.update(messages, (current) => [...current, item.text!]);
      }
      return Effect.void;
    });

    yield* client.handleServerNotification("mcpServer/startupStatus/updated", (payload) =>
      Ref.update(mcpStatuses, (current) => [
        ...current,
        { name: payload.name, status: payload.status },
      ]),
    );

    yield* client.handleUnknownServerNotification(() => Effect.void);
    yield* client.handleUnknownServerRequest(
      () => Effect.fail(new Error("not implemented")) as never,
    );

    console.log("[probe] sending initialize...");
    yield* client.request("initialize", {
      clientInfo: {
        name: "cadsensex-mcp-probe",
        title: "CadSensex MCP Probe",
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    } as never);
    yield* client.notify("initialized", undefined);

    console.log("[probe] starting thread with cadsense-cad-view MCP...");
    const opened = yield* client.request("thread/start", {
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: mcpConfig as { readonly [x: string]: unknown },
    });

    console.log("[probe] thread opened:", opened.thread.id);

    if (options.skipTurn) {
      console.log("[probe] --skip-turn: waiting 3s for MCP startup, then exiting.");
      yield* Effect.sleep("3 seconds");
      const statuses = yield* Ref.get(mcpStatuses);
      const stderr = yield* Ref.get(stderrBuffer);
      const cadViewReady = statuses.some(
        (entry) => entry.name === "cadsense-cad-view" && entry.status === "ready",
      );
      const rmcpEofs = stderr.filter(
        (entry) => entry.line.includes("rmcp::transport") && entry.line.includes("EOF"),
      );
      console.log("[probe] mcp statuses:", statuses);
      if (rmcpEofs.length > 0) {
        console.error(
          `[probe] FAIL: ${rmcpEofs.length} rmcp EOF errors observed — cadsense-cad-view child exited immediately.`,
        );
        process.exit(1);
      }
      if (!cadViewReady) {
        console.error("[probe] FAIL: cadsense-cad-view never reached status=ready.");
        process.exit(1);
      }
      console.log("[probe] PASS — cadsense-cad-view became ready and no rmcp EOF errors.");
      return;
    }

    console.log("[probe] sending turn:", PROMPT);
    yield* client.raw.request("turn/start", {
      threadId: opened.thread.id,
      input: [{ type: "text", text: PROMPT }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });

    console.log("[probe] waiting up to 90s for turn/completed or codex exit...");
    const result = yield* Effect.race(
      Queue.take(turnQueue),
      Effect.gen(function* () {
        while (true) {
          const exited = yield* Ref.get(childExited);
          if (exited) return { status: "__codex_exited__" } as const;
          yield* Effect.sleep("250 millis");
        }
      }),
    ).pipe(Effect.timeout("90 seconds"));

    const finalMessages = yield* Ref.get(messages);
    const statuses = yield* Ref.get(mcpStatuses);
    const stderr = yield* Ref.get(stderrBuffer);
    const cadViewReady = statuses.some(
      (entry) => entry.name === "cadsense-cad-view" && entry.status === "ready",
    );
    const cadViewFailed = statuses.some(
      (entry) => entry.name === "cadsense-cad-view" && entry.status === "failed",
    );
    const rmcpEofs = stderr.filter(
      (entry) => entry.line.includes("rmcp::transport") && entry.line.includes("EOF"),
    );

    console.log("[probe] mcp statuses:", statuses);
    console.log("[probe] turn result:", result);
    console.log("[probe] assistant messages:", finalMessages);

    const reasons: Array<string> = [];
    if (result.status === "__codex_exited__") {
      reasons.push("codex exited before producing turn/completed");
    } else if (result.status !== "completed") {
      const detail = "errorMessage" in result ? (result.errorMessage ?? "") : "";
      reasons.push(`turn status='${result.status}' (errorMessage='${detail}')`);
    }
    if (rmcpEofs.length > 0) {
      reasons.push(`${rmcpEofs.length} rmcp EOF stderr errors observed`);
    }
    if (cadViewFailed) {
      reasons.push("cadsense-cad-view MCP server reported status=failed");
    }
    if (!cadViewReady) {
      reasons.push("cadsense-cad-view never reached status=ready");
    }
    if (finalMessages.length === 0) {
      reasons.push("no assistant message was emitted");
    }

    if (reasons.length > 0) {
      console.error("[probe] FAIL:", reasons.join("; "));
      process.exit(1);
    }

    console.log("[probe] PASS — codex stayed alive, cadsense-cad-view ready, assistant responded.");
  });

  yield* Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const ctx = yield* Layer.buildWithScope(CodexClient.layerChildProcess(child), scope);
      yield* work.pipe(Effect.provide(ctx));
    }),
  );
});

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
