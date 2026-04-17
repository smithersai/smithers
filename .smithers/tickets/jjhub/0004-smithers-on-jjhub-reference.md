# Reference Architecture: Smithers on JJHub

> Target repo: **jjhub**
> Source: memo §3, §5 · roadmap Phase 1 → Phase 2

## Problem

Users want to run Smithers durably without inventing a runtime,
deployment, auth, and inspector story. Today they end up with a custom
stack per project — exactly the pain the field report captured.

## Goal

A single "Smithers on JJHub" reference: installable, documented,
opinionated, end-to-end. The answer to "how do I run Smithers for real?"

## Scope

### Reference stack

- **Runtime:** `@jjhub/smithers-runtime-workspace` (jjhub/0002)
- **Control plane:** Smithers Gateway behind JJHub auth
  (smithers/0023), deployed alongside the JJHub server.
- **Inspector:** JJHub web UI `/runs/:runId` (jjhub/0003).
- **Storage:** Smithers SQLite lives in a JJHub-managed persistent
  volume, snapshotted with workspace backups.
- **Secrets:** JJHub secret store → injected per workspace (0002).
- **VCS:** jj-native; each run captures a pointer (0001 vcs capability).
- **Cron:** Smithers cron scheduled through the JJHub scheduler, not a
  separate cron daemon.

### Example workflow

`examples/smithers-on-jjhub/` — a runnable reference project:
- A multi-task Smithers workflow (plan → implement → verify → review →
  report, matching memo §9 guardrail pattern).
- Approval gate before any merge.
- Diff-review guardrail before patch application.
- Scorer gate before the report step.
- A README that walks through running it against a fresh JJHub
  install in under 10 minutes.

### Docs

`docs/guides/smithers-on-jjhub.mdx`:
- Architecture diagram (the four layers from memo "Recommended
  architecture changes §2").
- Failure domains: engine, workspace, sandbox transport, provider auth,
  external tools — which layer owns recovery for each.
- One-command install (compose file or single binary).
- Auth: how humans + bots get tokens.
- Observability: which logs land where, which metrics to watch.
- Upgrade path: schema migrations, version compatibility with Smithers
  releases.

### Guardrail defaults

The reference ships the memo §9 defaults enabled:
- Approval required on destructive tools.
- Diff review required before applying file patches.
- Scorer gate before merge/deploy.
- CI/test hooks as explicit workflow steps, not side effects.

Make these toggle-able, but default to on — safest shape is the
easiest shape.

## Files

- `docs/guides/smithers-on-jjhub.mdx`
- `examples/smithers-on-jjhub/` (new)
- `deploy/smithers/` — compose + systemd + k8s variants referencing
  the JJHub runtime
- `packages/workflow/templates/` — opinionated starter workflow

## Testing

- E2E: follow the guide against a fresh JJHub install in CI; the
  example workflow runs to completion.
- E2E: kill the workspace mid-run; recovery per the documented failure
  domain doc succeeds.
- Doc smoke (mirrors smithers/0021): every command in the guide runs.
- Smoke: upgrade path — start on release N, upgrade to N+1, runs
  continue.

## Acceptance

- [ ] A new user can go from zero to a running Smithers workflow on
      JJHub in under 10 minutes following the guide.
- [ ] Example workflow demonstrates every memo §9 guardrail.
- [ ] Architecture + failure-domain doc is authoritative (no
      contradictions with Smithers docs).
- [ ] Guide is maturity `stable` — CI smoke tests every command.

## Blocks

- Depends on jjhub/0001, 0002, 0003, smithers/0023.
