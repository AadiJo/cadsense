// @effect-diagnostics nodeBuiltinImport:off
/**
 * ExternalLauncher - external application launch service interface.
 *
 * Owns process launch helpers for browser URLs and workspace paths
 * in configured editor integrations.
 *
 * @module ExternalLauncher
 */
import {
  EDITORS,
  ExternalLauncherError,
  type EditorId,
  type LaunchEditorInput,
} from "@cadsense/contracts";
import { isCommandAvailable, type CommandAvailabilityOptions } from "@cadsense/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

// ==============================
// Definitions
// ==============================

export { ExternalLauncherError };
export type { LaunchEditorInput };
export { isCommandAvailable } from "@cadsense/shared/shell";

interface EditorLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface ProcessLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.CommandOptions;
}

interface TargetPathAndPosition {
  readonly path: string;
  readonly line: string;
  readonly column: Option.Option<string>;
}

interface WpilibVsCodeInstall {
  readonly year: number;
  readonly command: string;
}

const TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;
const POWERSHELL_ARGUMENTS_PREFIX = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
] as const;

const DETACHED_IGNORE_STDIO_OPTIONS = {
  detached: true,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
} as const satisfies ChildProcess.CommandOptions;

function parseTargetPathAndPosition(target: string): Option.Option<TargetPathAndPosition> {
  const match = TARGET_WITH_POSITION_PATTERN.exec(target);
  if (!match?.[1] || !match[2]) {
    return Option.none();
  }

  return Option.some({
    path: match[1],
    line: match[2],
    column: Option.fromUndefinedOr(match[3]),
  });
}

function resolveCommandEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const parsedTarget = parseTargetPathAndPosition(target);

  switch (editor.launchStyle) {
    case "direct-path":
      return [target];
    case "goto":
      return Option.isSome(parsedTarget) ? ["--goto", target] : [target];
    case "line-column":
      return Option.match(parsedTarget, {
        onNone: () => [target],
        onSome: ({ path, line, column }) => [
          "--line",
          line,
          ...Option.match(column, {
            onNone: () => [],
            onSome: (value) => ["--column", value],
          }),
          path,
        ],
      });
  }
}

function resolveEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const baseArgs = "baseArgs" in editor ? editor.baseArgs : [];
  return [...baseArgs, ...resolveCommandEditorArgs(editor, target)];
}

function resolveAvailableCommand(
  commands: ReadonlyArray<string>,
  options: CommandAvailabilityOptions = {},
): Option.Option<string> {
  for (const command of commands) {
    if (isCommandAvailable(command, options)) {
      return Option.some(command);
    }
  }
  return Option.none();
}

function directoryExists(directoryPath: string): boolean {
  try {
    return NodeFs.statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(filePath: string): boolean {
  try {
    return NodeFs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function wpilibRootsForPlatform(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ReadonlyArray<string> {
  const userProfile = env.USERPROFILE?.trim();
  const publicProfile = env.PUBLIC?.trim();
  const home = env.HOME?.trim() || NodeOs.homedir();

  if (platform === "win32") {
    return [
      ...(userProfile ? [NodePath.join(userProfile, "wpilib")] : []),
      ...(publicProfile ? [NodePath.join(publicProfile, "wpilib")] : []),
      String.raw`C:\Users\Public\wpilib`,
    ];
  }

  return home ? [NodePath.join(home, "wpilib")] : [];
}

function hasWpilibVsCodeProfile(yearDirectory: string): boolean {
  const extensionsDirectory = NodePath.join(yearDirectory, "vscode", "data", "extensions");
  try {
    return NodeFs.readdirSync(extensionsDirectory, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && entry.name.startsWith("wpilibsuite.vscode-wpilib-"),
    );
  } catch {
    return false;
  }
}

function wpilibVsCodeCommandForYear(
  yearDirectory: string,
  year: number,
  platform: NodeJS.Platform,
): string | null {
  const extension = platform === "win32" ? ".cmd" : "";
  const launcherPath = NodePath.join(yearDirectory, "frccode", `frccode${year}${extension}`);
  if (fileExists(launcherPath)) return launcherPath;

  const codeLauncher = NodePath.join(
    yearDirectory,
    "vscode",
    "bin",
    platform === "win32" ? "code.cmd" : "code",
  );
  return fileExists(codeLauncher) ? codeLauncher : null;
}

function resolveWpilibVsCodeInstall(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Option.Option<WpilibVsCodeInstall> {
  const installs: WpilibVsCodeInstall[] = [];

  for (const root of wpilibRootsForPlatform(platform, env)) {
    if (!directoryExists(root)) continue;

    for (const entry of NodeFs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d{4}$/.test(entry.name)) continue;

      const year = Number(entry.name);
      const yearDirectory = NodePath.join(root, entry.name);
      if (!hasWpilibVsCodeProfile(yearDirectory)) continue;

      const command = wpilibVsCodeCommandForYear(yearDirectory, year, platform);
      if (command) installs.push({ year, command });
    }
  }

  installs.sort((left, right) => right.year - left.year);
  const latestInstall = installs[0];
  if (latestInstall) return Option.some(latestInstall);

  for (let year = 2035; year >= 2019; year -= 1) {
    const command = `frccode${year}`;
    if (isCommandAvailable(command, { platform, env })) {
      return Option.some({ year, command });
    }
  }

  return Option.none();
}

function encodeUtf16LeBase64(input: string): string {
  const bytes = new Uint8Array(input.length * 2);
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >>> 8;
  }
  return Encoding.encodeBase64(bytes);
}

function escapePowerShellStringLiteral(input: string): string {
  return `'${input.replaceAll("'", "''")}'`;
}

function resolvePowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  return `${env.SYSTEMROOT || env.windir || String.raw`C:\Windows`}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function resolveWslPowerShellPath(): string {
  return "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
}

function shouldUseWindowsBrowserFromWsl(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    platform === "linux" &&
    (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) &&
    env.SSH_CONNECTION === undefined &&
    env.SSH_TTY === undefined &&
    env.container === undefined
  );
}

function resolveWindowsBrowserLaunch(target: string, command: string): ProcessLaunch {
  const encodedCommand = encodeUtf16LeBase64(
    `$ProgressPreference = 'SilentlyContinue'; Start ${escapePowerShellStringLiteral(target)}`,
  );
  return {
    command,
    args: [...POWERSHELL_ARGUMENTS_PREFIX, encodedCommand],
    options: {
      detached: true,
      shell: false,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  };
}

function fileManagerCommandForPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      return "xdg-open";
  }
}

export function resolveBrowserLaunch(
  target: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ProcessLaunch {
  if (platform === "darwin") {
    return {
      command: "open",
      args: [target],
      options: DETACHED_IGNORE_STDIO_OPTIONS,
    };
  }

  if (platform === "win32") {
    return resolveWindowsBrowserLaunch(target, resolvePowerShellPath(env));
  }

  if (shouldUseWindowsBrowserFromWsl(platform, env)) {
    return resolveWindowsBrowserLaunch(target, resolveWslPowerShellPath());
  }

  return {
    command: "xdg-open",
    args: [target],
    options: DETACHED_IGNORE_STDIO_OPTIONS,
  };
}

export function resolveAvailableEditors(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<EditorId> {
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    if (editor.id === "wpilib-vscode") {
      if (Option.isSome(resolveWpilibVsCodeInstall(platform, env))) {
        available.push(editor.id);
      }
      continue;
    }

    if (editor.commands === null) {
      const command = fileManagerCommandForPlatform(platform);
      if (isCommandAvailable(command, { platform, env })) {
        available.push(editor.id);
      }
      continue;
    }

    const command = resolveAvailableCommand(editor.commands, { platform, env });
    if (Option.isSome(command)) {
      available.push(editor.id);
    }
  }

  return available;
}

/**
 * ExternalLauncherShape - Service API for browser and editor launch actions.
 */
export interface ExternalLauncherShape {
  /**
   * Launch a URL target in the default browser.
   */
  readonly launchBrowser: (target: string) => Effect.Effect<void, ExternalLauncherError>;

  /**
   * Launch a workspace path in a selected editor integration.
   *
   * Launches the editor as a detached process so server startup is not blocked.
   */
  readonly launchEditor: (input: LaunchEditorInput) => Effect.Effect<void, ExternalLauncherError>;
}

/**
 * ExternalLauncher - Service tag for browser/editor launch operations.
 */
export class ExternalLauncher extends Context.Service<ExternalLauncher, ExternalLauncherShape>()(
  "cadsense/process/ExternalLauncher",
) {}

// ==============================
// Implementations
// ==============================

export const resolveEditorLaunch = Effect.fn("resolveEditorLaunch")(function* (
  input: LaunchEditorInput,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<EditorLaunch, ExternalLauncherError> {
  yield* Effect.annotateCurrentSpan({
    "externalLauncher.editor": input.editor,
    "externalLauncher.cwd": input.cwd,
    "externalLauncher.platform": platform,
  });
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new ExternalLauncherError({ message: `Unknown editor: ${input.editor}` });
  }

  if (editorDef.commands) {
    if (editorDef.id === "wpilib-vscode") {
      const install = resolveWpilibVsCodeInstall(platform, env);
      if (Option.isSome(install)) {
        return {
          command: install.value.command,
          args: resolveEditorArgs(editorDef, input.cwd),
        };
      }
    }

    const command = Option.getOrElse(
      resolveAvailableCommand(editorDef.commands, { platform, env }),
      () => editorDef.commands[0],
    );
    return {
      command,
      args: resolveEditorArgs(editorDef, input.cwd),
    };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new ExternalLauncherError({ message: `Unsupported editor: ${input.editor}` });
  }

  return { command: fileManagerCommandForPlatform(platform), args: [input.cwd] };
});

const launchAndUnref = Effect.fn("externalLauncher.launchAndUnref")(function* (
  launch: ProcessLaunch,
  errorMessage: string,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(launch.command, launch.args, launch.options);

  yield* spawner.spawn(command).pipe(
    Effect.flatMap((handle) => handle.unref),
    Effect.asVoid,
    Effect.scoped,
    Effect.mapError((cause) => new ExternalLauncherError({ message: errorMessage, cause })),
  );
});

export const launchBrowser = Effect.fn("externalLauncher.launchBrowser")(function* (
  target: string,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  return yield* launchAndUnref(resolveBrowserLaunch(target), "Browser auto-open failed");
});

export const launchEditorProcess = Effect.fn("externalLauncher.launchEditorProcess")(function* (
  launch: EditorLaunch,
): Effect.fn.Return<void, ExternalLauncherError, ChildProcessSpawner.ChildProcessSpawner> {
  if (!isCommandAvailable(launch.command)) {
    return yield* new ExternalLauncherError({
      message: `Editor command not found: ${launch.command}`,
    });
  }

  const isWin32 = process.platform === "win32";
  yield* launchAndUnref(
    {
      command: launch.command,
      args: isWin32 ? launch.args.map((arg) => `"${arg}"`) : [...launch.args],
      options: {
        detached: true,
        shell: isWin32,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    },
    "failed to spawn detached process",
  );
});

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return {
    launchBrowser: (target) =>
      launchBrowser(target).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    launchEditor: (input) =>
      Effect.flatMap(resolveEditorLaunch(input), (launch) =>
        launchEditorProcess(launch).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
  } satisfies ExternalLauncherShape;
});

export const layer = Layer.effect(ExternalLauncher, make);
