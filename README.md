# CadSense

CadSense is a fast, local-first GUI for running Codex against real projects.

It gives Codex a desktop/web workspace with persistent threads, project-aware chat, terminals,
diffs, source-control context, and the operational state you need to understand what the agent is
doing.

> [!WARNING]
> CadSense is alpha software. The core workflows are useful today, but the project is still moving
> quickly. Expect rough edges, sharp logs, and occasional behavior changes.

## The Point

Codex is powerful in a terminal. CadSense is for the moments when you want a fuller workbench around
it: project state, conversation history, live activity, changed files, terminals, and review context
in one place.

The goal is not to hide the repo or abstract away the workflow. The goal is to make long-running
agent work easier to steer, inspect, and recover from.

## What It Does

- **Codex sessions**: start, resume, and inspect Codex work without losing the underlying project
  context.
- **Agent-first chat**: persistent threads, model picking, streamed events, pending approvals,
  plans, terminal context, and file attachments.
- **Source-control workflow**: branch controls, changed-file trees, diff panels, pull-request
  references, and project-aware git state.
- **Desktop and web surfaces**: an Electron shell, a Vite web app, and a Node backend coordinating
  the session lifecycle.
- **CAD-aware experiments**: early Onshape/CAD viewing and review paths live in the app while the
  product direction is still forming.

## Repository Map

| Path                               | Role                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `apps/server`                      | Node WebSocket server, CLI, Codex sessions, persistence, orchestration, terminals, auth, and Codex app-server support.  |
| `apps/web`                         | React/Vite client for chat, settings, diffs, CAD panels, provider controls, and environment connection state.           |
| `apps/desktop`                     | Electron shell, desktop lifecycle, updates, native settings, SSH launch, and local backend management.                  |
| `apps/marketing`                   | Public marketing/download site.                                                                                         |
| `packages/contracts`               | Shared Effect Schema contracts for RPC, provider events, settings, git, auth, and orchestration. Schema-only by design. |
| `packages/shared`                  | Shared runtime utilities with explicit subpath exports. No barrel index.                                                |
| `packages/effect-codex-app-server` | Generated/typed Codex app-server protocol client helpers.                                                               |
| `packages/effect-acp`              | Typed Agent Client Protocol support.                                                                                    |
| `packages/ssh`                     | SSH command, auth, config, and tunnel helpers.                                                                          |
| `packages/tailscale`               | Tailscale endpoint integration helpers.                                                                                 |
| `oxlint-plugin-cadsense`           | Project-specific lint rules.                                                                                            |
| `scripts`                          | Release, packaging, dev-runner, update-server, and build automation scripts.                                            |

## Architecture Notes

CadSense is currently Codex-only. The server starts `codex app-server` per session, speaks JSON-RPC
over stdio, normalizes runtime activity, and pushes domain events to the browser over WebSocket.

Important entry points:

- `apps/server/src/provider/` owns provider adapters and session runtimes.
- `apps/server/src/orchestration/` converts provider/runtime activity into app-level thread state.
- `apps/server/src/cli/` owns server, project, auth, MCP, and config commands.
- `apps/web/src/rpc/` owns browser-side WebSocket RPC and server-state handling.
- `apps/web/src/components/chat/` owns the core chat experience.
- `apps/desktop/src/` owns Electron lifecycle, native IPC, updates, SSH, and backend startup.

## License

MIT. See [LICENSE](./LICENSE).
