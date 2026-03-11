# Mr. Burns Codebase Layout

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
    mr-burns-spec.md
  package.json
  bun.lock
  tsconfig.base.json
```

## Applications

## `apps/daemon`

Primary backend/control-plane application.

Key directories:

- `src/server`: HTTP app and route handlers
- `src/services`: business logic for workspaces, workflows, git, diagnostics, and agent CLI integration
- `src/agents`: wrappers for CLI-based agents (`claude`, `codex`, `gemini`, `pi`)
- `src/db`: Bun SQLite client and workspace repository
- `src/domain`: default workflow templates and mock run/approval data
- `src/config`: app defaults and filesystem paths

Key runtime behavior:

- Serves API on `http://localhost:7332`
- Persists workspace metadata in `apps/daemon/.data/mr-burns.sqlite`
- Manages default workspace folder root in `apps/daemon/.data/workspaces`
- Stores workflow source files per workspace under `.mr-burns/workflows`

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
- Active workspace selection is stored in localStorage (`mr-burns.active-workspace-id`)

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
