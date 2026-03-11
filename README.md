# Mr. Burns

Mr. Burns is a workspace-first local control plane for authoring and operating Smithers workflows.

This repository is a Bun monorepo with:

- `apps/web`: React + Vite frontend
- `apps/daemon`: local Bun HTTP daemon
- `packages/shared`: shared Zod schemas and domain types
- `packages/client`: typed API client used by the frontend
- `packages/config`: placeholder package for shared tooling config

## Current implementation status

Implemented today:

- Workspace registry with SQLite persistence
- Workspace creation flows: create repo, clone repo, add local repo
- Workflow file management under `.mr-burns/workflows`
- AI-assisted workflow generation and editing via installed local agent CLIs
- Web UI for workspaces, workflows, settings, runs, and approvals

Currently mocked/stubbed:

- Run execution/orchestration data (`/runs`)
- Approval actions (`/approvals` UI buttons are present but not wired)
- Deep diagnostics and supervisor behavior

## Prerequisites

- Bun `1.2.x`
- Git CLI
- Optional for AI workflow generation/editing: at least one supported agent CLI installed on `PATH`
  - `claude`
  - `codex`
  - `gemini`
  - `pi`

## Quick start

```bash
bun install
```

Start daemon:

```bash
bun run dev:daemon
```

Start web app in a second terminal:

```bash
bun run dev:web
```

Open `http://localhost:5173`.

The web app defaults to `http://localhost:7332` for API calls. Override with:

```bash
VITE_BURNS_API_URL=http://localhost:7332
```

## Workspace scripts

- `bun run dev:web`: run Vite dev server
- `bun run dev:daemon`: run daemon with watch mode
- `bun run build:web`: build frontend
- `bun run typecheck`: typecheck shared, client, web, and daemon packages

Additional app-level scripts:

- `apps/web`: `bun run lint`, `bun run preview`
- `apps/daemon`: `bun run start`, `bun run typecheck`

## Runtime data locations

The daemon stores local state in `apps/daemon/.data`:

- SQLite DB: `apps/daemon/.data/mr-burns.sqlite`
- Managed workspace root: `apps/daemon/.data/workspaces`

Each managed workspace stores workflows at:

```txt
<workspace-path>/.mr-burns/workflows/<workflow-id>/workflow.tsx
```

## Documentation index

- [Codebase Layout](./docs/codebase-layout.md)
- [Daemon API Reference](./docs/daemon-api-reference.md)
- [Product Spec (target state)](./docs/mr-burns-spec.md)

## Notes

- There is no automated test suite in the repository yet.
- The product spec describes target behavior; current implementation details are captured in the docs above.
