<p align="center">
  <img src="./apps/web/src/assets/burns.png" alt="Burns logo" width="160" />
</p>

# Burns

**A workspace-first local control plane for authoring, running, and supervising Smithers workflows.**

Burns gives you one place to work with AI workflows that live inside real repositories.

- Register local repos as managed workspaces
- Author and edit Smithers workflows in `.smithers/workflows`
- Generate and revise workflows with local agent CLIs such as `codex` and `claude`
- Launch runs, stream events, inspect frames, and resume or cancel work
- Handle human approval gates without leaving the app
- Run as a web app, desktop shell, or CLI-backed local runtime

## What Burns does

Burns sits on top of Smithers and adds the operator-facing layer around it.

Smithers handles workflow execution, persistence, validation, and resumability. Burns handles the workspace model, workflow authoring surfaces, local runtime supervision, approvals, and the UI for operating all of it.

This makes Burns useful when you want more than `smithers run workflow.tsx`. It is for cases where you need to manage multiple repositories, inspect workflow files, guide authors toward good workflow structure, and supervise long-running local runs from a single control plane.

## How It Works

1. Add or create a repository as a Burns workspace.
2. Burns stores workspace metadata and resolves workflows from `.smithers/workflows/<workflow-id>/`.
3. The daemon manages a Smithers runtime for that workspace and exposes local APIs for workflows, runs, approvals, and settings.
4. The web or desktop UI talks to the daemon to browse workflows, edit files, start runs, and watch run state in real time.
5. When AI-assisted authoring is used, Burns shells out to installed local agent CLIs and writes the resulting workflow files back into the repo.
6. Smithers executes the workflow, persists task outputs and state, and Burns layers on event streaming, approval actions, and workspace supervision.

## Architecture

| Part | Role |
| --- | --- |
| `apps/web` | React UI for workspaces, workflows, runs, approvals, and settings |
| `apps/daemon` | Local Bun HTTP daemon, workspace registry, Smithers lifecycle manager, and workflow authoring APIs |
| `apps/desktop` | ElectroBun desktop shell that starts the daemon and blocks if another Burns instance is already running, with a dev-only attach escape hatch |
| `apps/cli` | CLI runtime for starting the daemon and serving built web assets |
| `packages/shared` | Shared schemas and domain types |
| `packages/client` | Typed API client used by the frontend |

## What Burns Leverages

- **Smithers** for workflow execution, structured outputs, persistence, resumability, and approval-aware orchestration
- **Bun** for the monorepo toolchain, daemon runtime, and CLI packaging
- **SQLite** for Burns workspace state and persisted run/event data
- **Local agent CLIs** for workflow generation and editing inside real repositories
- **React + Vite** for the primary UI
- **ElectroBun** for the desktop shell

## Run Locally

```bash
bun install
bun run dev:daemon
```

In a second terminal:

```bash
bun run dev:web
```

Open `http://localhost:5173`. The web app talks to the daemon at `http://localhost:7332` by default.

Other entry points:

```bash
bun run desktop:dev
bun run cli:start
```

## Current State

Today Burns includes workspace onboarding, workspace overview quick actions, workflow browsing, AI-assisted workflow generation and editing, launch-field inference, Smithers-backed run APIs, approvals, managed per-workspace Smithers processes, and desktop/CLI runtime shells.

## For Developers

- [Repository Guide](./docs/repository-guide.md)
- [Documentation Index](./docs/README.md)
- [Codebase Layout](./docs/codebase-layout.md)
- [Daemon API Reference](./docs/daemon-api-reference.md)
- [Product Spec](./docs/burns-spec.md)
