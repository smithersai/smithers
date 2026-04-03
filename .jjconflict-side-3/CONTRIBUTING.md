# Contributing

This guide is the default contributor path for Burns. Use it when you need to get the repo running, decide where to make a change, and verify work before opening a PR.

## Prerequisites

- Bun `1.2.19`
- Git CLI
- Optional for AI workflow generation and editing: at least one supported local agent CLI on `PATH`
  - `claude`
  - `codex`
  - `gemini`
  - `pi`

## Choose A Development Loop

### Web + daemon

Use this for most product work.

```bash
bun install
bun run dev:daemon
```

In a second terminal:

```bash
bun run dev:web
```

Then open `http://localhost:5173`.

The web app talks to `http://localhost:7332` by default.

### Desktop

Use this when the change involves the desktop shell, tray behavior, startup rules, or runtime config injection.

```bash
bun run desktop:dev
```

Important desktop dev behavior:

- `bun run desktop:dev` enables `BURNS_DESKTOP_ALLOW_ATTACH_EXISTING=1`, so desktop mode can attach to an already running Burns daemon during development.
- `BURNS_DESKTOP_DEV_SOURCE=views|vite` chooses between bundled views and a live Vite server.
- `BURNS_DESKTOP_DEV_VITE_URL=http://localhost:5173` overrides the Vite URL used in desktop dev mode.
- `BURNS_DESKTOP_FORCE_API_URL=http://localhost:7332` overrides the daemon API URL injected into the web app.
- Packaged desktop startup blocks when another Burns daemon is already bound to the configured desktop URL. Dev mode relaxes that by allowing attach-to-existing behavior.

Practical recommendation:

- Use daemon + web for most backend and UI iteration.
- Use desktop mode when you need to verify shell, tray, or runtime-config behavior.

### CLI runtime

Use this when you want to run Burns without the desktop shell.

```bash
bun run cli:start
```

## Where To Make Common Changes

- `apps/daemon`: daemon routes, services, workspace handling, Smithers lifecycle, local persistence
- `apps/web`: React routes, feature UI, app shell, settings, runs, approvals, inbox
- `packages/shared`: shared Zod schemas and domain contracts
- `packages/client`: typed frontend client for daemon APIs
- `apps/desktop`: desktop shell, tray behavior, runtime bootstrapping, injected config
- `apps/cli`: CLI startup flow and packaged web serving

If you are new to the repo, start with [Getting Started for Smithers Developers](./docs/getting-started-smithers-developers.md) and [Repository Guide](./docs/repository-guide.md).

## Verification Before Opening A PR

Run the baseline checks from the repo root unless your change clearly does not affect that area:

```bash
bun run typecheck
cd apps/web && bun run lint
cd apps/daemon && bun run test
cd apps/cli && bun run test
cd apps/desktop && bun run test
```

Additional notes:

- Prefer adding or updating tests when behavior changes.
- Keep docs in sync with user-facing or contributor-facing behavior changes.
- Release workflows exist under `.github/workflows`, but there is not yet a general CI guide beyond the release docs.

## Contribution Expectations

- Keep changes scoped and coherent.
- Prefer tests for behavior changes.
- Update `README.md`, `docs/*`, and `CHANGELOG.md` when the change affects onboarding, workflows, release behavior, or contributor expectations.
- Preserve the distinction between onboarding docs and lower-level reference docs:
  - `README.md`: orientation and quick start
  - `docs/getting-started-smithers-developers.md`: tutorial path
  - `CONTRIBUTING.md`: contributor workflow and checks
  - `docs/repository-guide.md`: repo map and commands
  - app-level READMEs: package-specific runtime details

## More Reading

- [README](./README.md)
- [Documentation Index](./docs/README.md)
- [Repository Guide](./docs/repository-guide.md)
- [Codebase Layout](./docs/codebase-layout.md)
- [Daemon API Reference](./docs/daemon-api-reference.md)
