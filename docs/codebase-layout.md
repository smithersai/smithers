# Burns Codebase Layout

This document describes the current implemented layout of the repository.

## Top-level structure

```txt
burns/
  apps/
    daemon/           # Bun HTTP daemon + local persistence + workspace/workflow services
    web/              # React/Vite frontend
  packages/
    client/           # Typed API client for the daemon
    shared/           # Shared Zod schemas and domain types
    config/           # Placeholder package for shared tooling config
  docs/
    codebase-layout.md
    daemon-api-reference.md
    burns-spec.md
  package.json
  bun.lock
  tsconfig.base.json
```

## Applications

## `apps/daemon`

Primary backend/control-plane application.

Key directories:

- `src/server`: HTTP app and route handlers
- `src/services`: business logic for workspaces, workflows, runs/approvals, git, diagnostics, and Smithers instance lifecycle
- `src/jobs`: process entrypoints used by daemon-managed child workers (for example workspace Smithers runner)
- `src/agents`: wrappers for CLI-based agents (`claude`, `codex`, `gemini`, `pi`)
- `src/db`: Bun SQLite client and workspace repository
- `src/domain`: default workflow templates and seed fixture data
- `src/config`: app defaults and filesystem paths

Key runtime behavior:

- Serves API on `http://localhost:7332`
- Persists workspace metadata in `~/.burns/burns.sqlite` by default across direct daemon/web, CLI, and desktop runs
- Defaults the workspace creation root to `~/Documents/Burns`
- Stores workflow source files per workspace under `.smithers/workflows`
- Supervises one Smithers process per workspace (when enabled), including crash restart and shutdown handling

## `apps/web`

Frontend built with React 19, React Router, and TanStack Query.

Key directories:

- `src/app`: app shell, route definitions, and top-level providers
- `src/app/routes`: page-level routes (`workflows`, `workspaces/new`, `settings`, `w/:workspaceId/*`)
- `src/features`: feature hooks by domain (`workspaces`, `workflows`, `runs`, `approvals`, `agents`, `settings`)
- `src/components/ui`: shadcn/base-ui primitives
- `src/components/ai-elements`: AI element wrappers used by workflow generation/edit flows
- `src/lib/api/client.ts`: singleton `BurnsClient` instance

State conventions:

- Server state is managed with TanStack Query
- Active workspace selection is stored in localStorage (`burns.active-workspace-id`)

## Shared packages

## `packages/shared`

Shared contract package with Zod schemas and inferred types:

- workspaces
- workflows
- runs
- approvals
- settings
- agent CLI metadata and workflow generation/edit payloads

## `packages/client`

Typed HTTP client (`BurnsClient`) used by the web app:

- wraps daemon API calls
- parses API responses with `packages/shared` schemas
- normalizes errors to thrown `Error` instances

## `packages/config`

Reserved package for shared linting/TypeScript config. It is present but intentionally minimal right now.

## Cross-app flow

1. Web app loads and reads active workspace context.
2. Web app calls daemon endpoints via `BurnsClient`.
3. Daemon route handlers validate request bodies (where applicable) with shared schemas.
4. Daemon services interact with SQLite, local filesystem, git, and optional agent CLIs.
5. Results are returned as JSON and cached in TanStack Query on the frontend.

## Workspace UI behavior (current)

- Overview route provides workspace summary cards for branch, workflows, active runs, and approvals, plus local `Open Folder` and `Copy Path` quick actions when using a loopback daemon URL.
- Runs route supports one-click run starts per workflow and run list navigation to run detail.
- Run detail consumes persisted event history and attaches SSE with reconnect using `afterSeq`.
- Approvals route provides pending approval actions (approve/deny) with operator attribution.
- Workspace server control calls (`status`, `start`, `restart`, `stop`) are exposed in the client API and backed by daemon routes.
