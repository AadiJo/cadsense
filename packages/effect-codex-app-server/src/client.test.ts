// @effect-diagnostics nodeBuiltinImport:off
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexClient from "./client.ts";

it("resolves Windows npm command shims without passing arguments through cmd.exe", () => {
  if (process.platform !== "win32") return;
  const prefix = mkdtempSync(NodePath.join(tmpdir(), "codex-command-shim-"));
  try {
    const script = NodePath.join(prefix, "node_modules", "@openai", "codex", "bin", "codex.js");
    mkdirSync(NodePath.dirname(script), { recursive: true });
    writeFileSync(script, "");
    writeFileSync(NodePath.join(prefix, "node.exe"), "");
    writeFileSync(
      NodePath.join(prefix, "codex.cmd"),
      [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        'SET "_prog=%dp0%\\node.exe"',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
      ].join("\n"),
    );
    const args = ["app-server", "--config", "value & whoami"];

    const resolved = CodexClient.resolveCommandForSpawn(
      { command: "codex", args, env: { PATH: prefix, PATHEXT: ".EXE;.CMD" } },
      "win32",
    );

    assert.equal(resolved.command, NodePath.join(prefix, "node.exe"));
    assert.deepEqual(resolved.args, [script, ...args]);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

it("resolves pnpm Windows command shims without a shell", () => {
  if (process.platform !== "win32") return;
  const prefix = mkdtempSync(NodePath.join(tmpdir(), "codex-pnpm-shim-"));
  try {
    const relativeScript = NodePath.join(
      "global",
      "5",
      ".pnpm",
      "@openai+codex",
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    const script = NodePath.join(prefix, relativeScript);
    mkdirSync(NodePath.dirname(script), { recursive: true });
    writeFileSync(script, "");
    writeFileSync(NodePath.join(prefix, "node.exe"), "");
    writeFileSync(
      NodePath.join(prefix, "codex.cmd"),
      [
        "@SETLOCAL",
        '@IF EXIST "%~dp0\\node.exe" (',
        `  "%~dp0\\node.exe" "%~dp0\\${relativeScript}" %*`,
        ") ELSE (",
        "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
        `  node "%~dp0\\${relativeScript}" %*`,
        ")",
      ].join("\n"),
    );
    const args = ["app-server", "--config", "value & whoami"];

    const resolved = CodexClient.resolveCommandForSpawn(
      { command: "codex", args, cwd: prefix, env: { PATH: "", PATHEXT: ".CMD" } },
      "win32",
    );

    assert.equal(resolved.command, NodePath.join(prefix, "node.exe"));
    assert.deepEqual(resolved.args, [script, ...args]);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

it("applies Windows PATH overrides case-insensitively", () => {
  if (process.platform !== "win32") return;
  const prefix = mkdtempSync(NodePath.join(tmpdir(), "codex-path-casing-"));
  const commandName = "codex-path-casing-fixture";
  try {
    const shim = NodePath.join(prefix, `${commandName}.cmd`);
    writeFileSync(shim, "@echo off\n");
    const inheritedPathKey =
      Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const overridePathKey = inheritedPathKey === "PATH" ? "Path" : "PATH";

    const resolved = CodexClient.resolveCommandForSpawn(
      {
        command: commandName,
        env: { [overridePathKey]: prefix, PATHEXT: ".CMD" },
      },
      "win32",
    );

    assert.equal(resolved.command.toLowerCase(), shim.toLowerCase());
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

it("resolves commands from quoted Windows PATH entries", () => {
  if (process.platform !== "win32") return;
  const prefix = mkdtempSync(NodePath.join(tmpdir(), "codex quoted path "));
  const commandName = "codex-quoted-path-fixture";
  try {
    const shim = NodePath.join(prefix, `${commandName}.cmd`);
    writeFileSync(shim, "@echo off\n");

    const resolved = CodexClient.resolveCommandForSpawn(
      {
        command: commandName,
        env: { PATH: `"${prefix}"`, PATHEXT: ".CMD" },
      },
      "win32",
    );

    assert.equal(resolved.command.toLowerCase(), shim.toLowerCase());
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

it("selects a native node runtime even when CMD precedes EXE in PATHEXT", () => {
  if (process.platform !== "win32") return;
  const prefix = mkdtempSync(NodePath.join(tmpdir(), "codex-node-runtime-"));
  try {
    const shimDirectory = NodePath.join(prefix, "shim");
    const runtimeDirectory = NodePath.join(prefix, "runtime");
    const script = NodePath.join(shimDirectory, "node_modules", "@openai", "codex", "codex.js");
    mkdirSync(NodePath.dirname(script), { recursive: true });
    mkdirSync(runtimeDirectory, { recursive: true });
    writeFileSync(script, "");
    writeFileSync(NodePath.join(runtimeDirectory, "node.cmd"), "@echo off\n");
    writeFileSync(NodePath.join(runtimeDirectory, "node.exe"), "");
    writeFileSync(
      NodePath.join(shimDirectory, "codex.cmd"),
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\@openai\\codex\\codex.js" %*`,
    );

    const resolved = CodexClient.resolveCommandForSpawn(
      {
        command: "codex",
        env: {
          PATH: `${shimDirectory};${runtimeDirectory}`,
          PATHEXT: ".CMD;.EXE",
        },
      },
      "win32",
    );

    assert.equal(resolved.command, NodePath.join(runtimeDirectory, "node.exe"));
    assert.deepEqual(resolved.args, [script]);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

it("does not execute a script mentioned only in unrecognized shim content", () => {
  if (process.platform !== "win32") return;
  const prefix = mkdtempSync(NodePath.join(tmpdir(), "codex-untrusted-shim-"));
  try {
    const script = NodePath.join(prefix, "payload.js");
    writeFileSync(script, "");
    const shim = NodePath.join(prefix, "codex.cmd");
    writeFileSync(shim, `@echo off\nrem "%dp0%\\payload.js" %*\n`);

    const resolved = CodexClient.resolveCommandForSpawn(
      { command: "codex", cwd: prefix, env: { PATH: "", PATHEXT: ".CMD" } },
      "win32",
    );

    assert.equal(resolved.command.toLowerCase(), shim.toLowerCase());
    assert.deepEqual(resolved.args, []);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/codex-app-server-mock-peer.ts"),
);

it.layer(NodeServices.layer)("effect-codex-app-server client", (it) => {
  const makeHandle = () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const command = ChildProcess.make("bun", ["run", yield* mockPeerPath], {
        cwd: path.join(import.meta.dirname, ".."),
        shell: process.platform === "win32",
      });
      return yield* spawner.spawn(command);
    });

  it.effect("initializes, handles typed server requests, and reads account and skills data", () =>
    Effect.gen(function* () {
      const userInputRequests = yield* Ref.make<Array<unknown>>([]);
      const messageDeltas = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const clientLayer = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(clientLayer, scope);

      const result = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;

        yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
          Ref.update(userInputRequests, (current) => [...current, payload]).pipe(
            Effect.as({
              answers: {
                approved: {
                  answers: ["yes"],
                },
              },
            }),
          ),
        );

        yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
          Ref.update(messageDeltas, (current) => [...current, payload]),
        );

        const initialized = yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
        assert.equal(initialized.userAgent, "mock-codex-app-server");

        yield* client.notify("initialized", undefined);

        const account = yield* client.request("account/read", {});
        assert.equal(account.requiresOpenaiAuth, false);
        assert.deepEqual(account.account, {
          type: "chatgpt",
          email: "mock@example.com",
          planType: "plus",
        });

        const skills = yield* client.request("skills/list", {
          cwds: [process.cwd()],
        });
        assert.equal(skills.data.length, 1);
        assert.equal(skills.data[0]?.cwd, process.cwd());

        return {
          account,
          skills,
        };
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.equal(result.skills.data[0]?.skills.length, 0);
      assert.deepEqual(yield* Ref.get(userInputRequests), [
        {
          itemId: "item-approval-1",
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "approved",
              header: "Approve",
              question: "Continue with the mock skills request?",
              options: [
                {
                  label: "yes",
                  description: "Approve the request",
                },
              ],
            },
          ],
        },
      ]);
      assert.deepEqual(yield* Ref.get(messageDeltas), [
        {
          delta: "Mock server is ready.",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      ]);
    }),
  );

  it.effect("initializes a command-backed app-server client", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const scope = yield* Scope.make();
      const clientLayer = CodexClient.layerCommand({
        command: "bun",
        args: ["run", yield* mockPeerPath],
        cwd: path.join(import.meta.dirname, ".."),
      });
      const context = yield* Layer.buildWithScope(clientLayer, scope);

      const initialized = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        return yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.equal(initialized.userAgent, "mock-codex-app-server");
    }),
  );
});
