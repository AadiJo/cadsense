import { ClaudeSettings, ProviderInstanceId } from "@cadsense/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@cadsense/shared/model";
import { expect } from "vitest";

import { ServerConfig } from "../config.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import { sanitizeThreadTitle } from "./TextGenerationUtils.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const PATH_DELIMITER = process.platform === "win32" ? ";" : ":";

const ClaudeTextGenerationTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "cadsense-claude-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeFakeClaudeBinary(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const fakeClaudeScriptPath = path.join(binDir, "fake-claude.mjs");
    const claudePath = path.join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      fakeClaudeScriptPath,
      [
        "import { readFileSync } from 'node:fs';",
        "const args = process.argv.slice(2).join(' ').replaceAll('\\\\\"', '\"');",
        "let stdinContent = '';",
        "try { stdinContent = readFileSync(0, 'utf8'); } catch {}",
        "const mustContain = process.env.CADSENSE_FAKE_CLAUDE_ARGS_MUST_CONTAIN;",
        "if (mustContain && !args.includes(mustContain)) { console.error('args missing expected content'); process.exit(2); }",
        "const mustNotContain = process.env.CADSENSE_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;",
        "if (mustNotContain && args.includes(mustNotContain)) { console.error('args contained forbidden content'); process.exit(3); }",
        "const stdinMustContain = process.env.CADSENSE_FAKE_CLAUDE_STDIN_MUST_CONTAIN;",
        "if (stdinMustContain && !stdinContent.includes(stdinMustContain)) { console.error('stdin missing expected content'); process.exit(4); }",
        "const homeMustBe = process.env.CADSENSE_FAKE_CLAUDE_HOME_MUST_BE;",
        "if (homeMustBe && process.env.HOME !== homeMustBe) { console.error(`HOME was ${process.env.HOME ?? ''}`); process.exit(5); }",
        "if (process.env.CADSENSE_FAKE_CLAUDE_STDERR) console.error(process.env.CADSENSE_FAKE_CLAUDE_STDERR);",
        "process.stdout.write(process.env.CADSENSE_FAKE_CLAUDE_OUTPUT ?? '');",
        "process.exit(Number(process.env.CADSENSE_FAKE_CLAUDE_EXIT_CODE ?? '0'));",
        "",
      ].join("\n"),
    );
    yield* fs.writeFileString(
      claudePath,
      [
        ...(process.platform === "win32"
          ? ["@echo off", `bun "${fakeClaudeScriptPath}" %*`]
          : ["#!/bin/sh", `exec bun '${fakeClaudeScriptPath.replaceAll("'", "'\\''")}' "$@"`]),
        "",
      ].join(process.platform === "win32" ? "\r\n" : "\n"),
    );
    yield* fs.chmod(claudePath, 0o755);
    return binDir;
  });
}

function withFakeClaudeEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    homeMustBe?: string;
    claudeConfig?: Partial<ClaudeSettings>;
  },
  effectFn: (textGeneration: TextGenerationShape) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-claude-text-" });
    const binDir = yield* makeFakeClaudeBinary(tempDir);
    const previousPath = process.env.PATH;
    const previousOutput = process.env.CADSENSE_FAKE_CLAUDE_OUTPUT;
    const previousExitCode = process.env.CADSENSE_FAKE_CLAUDE_EXIT_CODE;
    const previousStderr = process.env.CADSENSE_FAKE_CLAUDE_STDERR;
    const previousArgsMustContain = process.env.CADSENSE_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
    const previousArgsMustNotContain = process.env.CADSENSE_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
    const previousStdinMustContain = process.env.CADSENSE_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
    const previousHomeMustBe = process.env.CADSENSE_FAKE_CLAUDE_HOME_MUST_BE;

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.PATH = `${binDir}${PATH_DELIMITER}${previousPath ?? ""}`;
        process.env.CADSENSE_FAKE_CLAUDE_OUTPUT = input.output;

        if (input.exitCode !== undefined) {
          process.env.CADSENSE_FAKE_CLAUDE_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.CADSENSE_FAKE_CLAUDE_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.CADSENSE_FAKE_CLAUDE_STDERR = input.stderr;
        } else {
          delete process.env.CADSENSE_FAKE_CLAUDE_STDERR;
        }

        if (input.argsMustContain !== undefined) {
          process.env.CADSENSE_FAKE_CLAUDE_ARGS_MUST_CONTAIN = input.argsMustContain;
        } else {
          delete process.env.CADSENSE_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
        }

        if (input.argsMustNotContain !== undefined) {
          process.env.CADSENSE_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = input.argsMustNotContain;
        } else {
          delete process.env.CADSENSE_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.CADSENSE_FAKE_CLAUDE_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.CADSENSE_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
        }

        if (input.homeMustBe !== undefined) {
          process.env.CADSENSE_FAKE_CLAUDE_HOME_MUST_BE = input.homeMustBe;
        } else {
          delete process.env.CADSENSE_FAKE_CLAUDE_HOME_MUST_BE;
        }
      }),
      () =>
        Effect.sync(() => {
          process.env.PATH = previousPath;

          if (previousOutput === undefined) {
            delete process.env.CADSENSE_FAKE_CLAUDE_OUTPUT;
          } else {
            process.env.CADSENSE_FAKE_CLAUDE_OUTPUT = previousOutput;
          }

          if (previousExitCode === undefined) {
            delete process.env.CADSENSE_FAKE_CLAUDE_EXIT_CODE;
          } else {
            process.env.CADSENSE_FAKE_CLAUDE_EXIT_CODE = previousExitCode;
          }

          if (previousStderr === undefined) {
            delete process.env.CADSENSE_FAKE_CLAUDE_STDERR;
          } else {
            process.env.CADSENSE_FAKE_CLAUDE_STDERR = previousStderr;
          }

          if (previousArgsMustContain === undefined) {
            delete process.env.CADSENSE_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
          } else {
            process.env.CADSENSE_FAKE_CLAUDE_ARGS_MUST_CONTAIN = previousArgsMustContain;
          }

          if (previousArgsMustNotContain === undefined) {
            delete process.env.CADSENSE_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
          } else {
            process.env.CADSENSE_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = previousArgsMustNotContain;
          }

          if (previousStdinMustContain === undefined) {
            delete process.env.CADSENSE_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
          } else {
            process.env.CADSENSE_FAKE_CLAUDE_STDIN_MUST_CONTAIN = previousStdinMustContain;
          }

          if (previousHomeMustBe === undefined) {
            delete process.env.CADSENSE_FAKE_CLAUDE_HOME_MUST_BE;
          } else {
            process.env.CADSENSE_FAKE_CLAUDE_HOME_MUST_BE = previousHomeMustBe;
          }
        }),
    );

    const config = decodeClaudeSettings(input.claudeConfig ?? {});
    const textGeneration = yield* makeClaudeTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(ClaudeTextGenerationTestLayer)("ClaudeTextGeneration", (it) => {
  it.effect("forwards Claude thinking settings for Haiku without passing effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            subject: "Add important change",
            body: "",
          },
        }),
        argsMustContain: "alwaysThinkingEnabled",
        argsMustNotContain: "--effort",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/claude-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-haiku-4-5", [
                { id: "thinking", value: false },
                { id: "effort", value: "high" },
              ]),
            },
          });

          expect(generated.subject).toBe("Add important change");
        }),
    ),
  );

  it.effect("forwards Claude fast mode and supported effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Improve orchestration flow",
            body: "Body",
          },
        }),
        argsMustContain: "fastMode",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/claude-effect",
            commitSummary: "Improve orchestration",
            diffSummary: "1 file changed",
            diffPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-6", [
                { id: "effort", value: "max" },
                { id: "fastMode", value: true },
              ]),
            },
          });

          expect(generated.title).toBe("Improve orchestration flow");
        }),
    ),
  );

  it.effect("generates thread titles through the Claude provider", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title:
              '  "Reconnect failures after restart because the session state does not recover"  ',
          },
        }),
        stdinMustContain: "You write concise thread titles for coding conversations.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Please investigate reconnect failures after restarting the session.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe(
            sanitizeThreadTitle(
              '"Reconnect failures after restart because the session state does not recover"',
            ),
          );
        }),
    ),
  );

  it.effect("runs Claude text generation with the configured Claude HOME", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeHome = path.join(process.cwd(), ".claude-work-test");
      return yield* withFakeClaudeEnv(
        {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          output: JSON.stringify({
            structured_output: {
              title: "Use Claude home",
            },
          }),
          homeMustBe: claudeHome,
          claudeConfig: { homePath: claudeHome },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "thread title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: "claude-sonnet-4-6",
              },
            });

            expect(generated.title).toBe(sanitizeThreadTitle("Use Claude home"));
          }),
      );
    }),
  );

  it.effect("falls back when Claude thread title normalization becomes whitespace-only", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: '  """   """  ',
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
          });

          expect(generated.title).toBe("New thread");
        }),
    ),
  );
});
