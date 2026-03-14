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
- Run Burns as a web app, desktop shell, or CLI-backed local runtime

## Burns for Smithers users

If you already know Smithers, Burns is the layer around it.

- Smithers owns workflow execution, persistence, validation, resumability, and approval-aware orchestration.
- Burns owns workspace registration, workflow authoring surfaces, local runtime supervision, event viewing, approvals UI, and the web/desktop shells used to operate workflows.

Burns is useful when `smithers run workflow.tsx` is no longer enough on its own. Use it when you want to manage multiple repos, browse workflow files, guide workflow authoring from a UI, or supervise long-running local runs from one place.

## Quick Start For Contributors

Install dependencies:

```bash
bun install
```

Start the daemon:

```bash
bun run dev:daemon
```

Start the web app in a second terminal:

```bash
bun run dev:web
```

Open `http://localhost:5173`.

Optional desktop loop:

```bash
bun run desktop:dev
```

By default the web app talks to the daemon at `http://localhost:7332`.

## Choose Your Runtime

### Web dev loop

Use this for most backend and UI changes.

- Run `bun run dev:daemon`
- Run `bun run dev:web`
- Open `http://localhost:5173`

### Desktop dev loop

Use this when you need to test the shell, tray behavior, startup rules, or injected runtime config.

- Run `bun run desktop:dev`
- Desktop dev mode allows attaching to an already running Burns daemon
- Set `BURNS_DESKTOP_DEV_SOURCE=vite` to load a live Vite server instead of bundled views
- Set `BURNS_DESKTOP_DEV_VITE_URL=http://localhost:5173` to point desktop mode at a custom Vite URL
- Set `BURNS_DESKTOP_FORCE_API_URL=http://localhost:7332` to override the injected daemon API URL

### CLI runtime

Use this when you want Burns without the desktop shell.

```bash
bun run cli:start
```

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
| `apps/desktop` | ElectroBun desktop shell that starts the daemon, runs in the macOS tray after window close, and blocks if another Burns instance is already running except for a dev-only attach escape hatch |
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

## Current State

Today Burns includes workspace onboarding, workspace overview quick actions, workflow browsing, AI-assisted workflow generation and editing, launch-field inference, Smithers-backed run APIs, approvals, managed per-workspace Smithers processes, desktop/CLI runtime shells, and a background desktop tray mode with aggregated pending/running workflow counts.

## Where To Look Next

- [Getting Started for Smithers Developers](./docs/getting-started-smithers-developers.md)
- [Contributing Guide](./CONTRIBUTING.md)
- [Repository Guide](./docs/repository-guide.md)
- [Documentation Index](./docs/README.md)
- [Codebase Layout](./docs/codebase-layout.md)
- [Daemon API Reference](./docs/daemon-api-reference.md)
- [Product Spec](./docs/burns-spec.md)
