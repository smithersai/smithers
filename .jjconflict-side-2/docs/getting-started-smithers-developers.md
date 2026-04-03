# Getting Started For Smithers Developers

This guide is for developers who already understand Smithers and want the shortest path to becoming productive in Burns.

## What Burns Adds On Top Of Smithers

Smithers is still the workflow engine. It owns workflow execution, persistence, resumability, validation, and approval-aware orchestration.

Burns adds the operator-facing layer around that engine:

- workspace registration and local repo management
- workflow browsing and authoring surfaces
- daemon-managed local runtimes
- run/event inspection
- approvals and inbox UI
- web, desktop, and CLI shells for operating workflows

If Smithers is the runtime, Burns is the local control plane around it.

## Learn The Repo Shape

You do not need the full codebase map to get started. Start with these parts:

- `apps/daemon`: local Bun daemon, workspace model, Smithers lifecycle management, workflow APIs
- `apps/web`: React UI for workspaces, workflows, runs, approvals, inbox, and settings
- `apps/desktop`: ElectroBun shell for tray and desktop runtime behavior
- `apps/cli`: CLI runtime for serving Burns without the desktop shell
- `packages/shared`: shared schemas and domain types
- `packages/client`: typed API client used by the frontend

For the full map, use [Repository Guide](./repository-guide.md) and [Codebase Layout](./codebase-layout.md).

## Run Burns Locally

Install dependencies from the repo root:

```bash
bun install
```

Start the daemon:

```bash
bun run dev:daemon
```

Start the web app in another terminal:

```bash
bun run dev:web
```

Open `http://localhost:5173`.

The normal contributor loop is daemon + web. Use it for most changes.

## Optionally Run The Desktop Shell

Use desktop mode when you need to verify shell behavior instead of just the app UI:

```bash
bun run desktop:dev
```

This is mainly for:

- tray behavior
- desktop startup/attach behavior
- injected runtime config
- packaged-view versus Vite-view loading

Desktop dev mode can attach to an already running Burns daemon, so it works well alongside the normal daemon/web loop.

## Create Or Add A Workspace

Once Burns is running:

1. Open the app.
2. Finish onboarding if prompted.
3. Add an existing repo, clone one, or create a new workspace from the UI.
4. Open the workspace and browse its workflows.

Burns resolves workflows from:

```txt
<workspace-path>/.smithers/workflows/<workflow-id>/
```

Primary workflow entrypoints are usually:

```txt
<workspace-path>/.smithers/workflows/<workflow-id>/workflow.tsx
<workspace-path>/.smithers/workflows/<workflow-id>/workflow.ts
```

## Know Where Burns Stores State

Burns keeps its own local app state separate from the repo you are operating on.

By default:

- Burns app data lives under `~/.burns`
- workspace metadata is stored in `~/.burns/burns.sqlite`
- managed workspace runtimes store Smithers state at `<workspace-path>/.smithers/state/smithers.db`

Workflow source stays in the workspace repo itself under `.smithers/workflows`.

## Make A Safe First Change

For a first contribution, use the web + daemon loop and pick a change that stays inside one layer:

- daemon behavior: `apps/daemon`
- UI behavior: `apps/web`
- shared request/response contracts: `packages/shared` and `packages/client`
- shell/tray/runtime-config behavior: `apps/desktop`

Then run the checks relevant to your change. The default contributor baseline is:

```bash
bun run typecheck
cd apps/web && bun run lint
cd apps/daemon && bun run test
cd apps/cli && bun run test
cd apps/desktop && bun run test
```

Use [Contributing](../CONTRIBUTING.md) for the full contributor workflow.
