# Implement Smithers Runtime on JJHub Workspaces

> Target repo: **jjhub**
> Source: memo §3 · roadmap Phase 1

## Problem

The capability contract (jjhub/0001) is inert without a blessed
implementation. JJHub workspaces already provide jj-native repos,
microVM isolation, suspend/resume, and streaming — the exact primitives
Smithers needs.

## Goal

Ship `@jjhub/smithers-runtime-workspace` — the reference runtime —
passing the conformance suite from jjhub/0001.

## Scope

### Mapping

| Contract capability | JJHub implementation |
|---|---|
| `start(spec)` | create workspace from spec; install agent deps |
| `suspend/resume` | workspace snapshot suspend/resume |
| `stop(graceful/force)` | graceful SIGTERM w/ timeout, then SIGKILL |
| `fs.persist/restore` | workspace snapshot + label |
| `vcs` | jj-native backend; pointer = change id |
| `exec/spawn` | workspace command channel |
| `browser` | headed/headless browser provisioned per-workspace |
| `secrets` | workspace env injection with redaction in logs |
| `network` | workspace network policy (egress rules) |
| `logs/metrics` | existing workspace streams |

### Lease ↔ suspend interaction

When a workspace suspends, the Smithers engine inside it pauses. The
runtime must notify the Smithers control plane via a gateway webhook so
the lease grace period extends; otherwise the run would be marked
`stale` on resume. Document and implement this handshake.

### Spec defaults for Smithers

Publish an opinionated `SmithersWorkspaceSpec` preset:

- jj-native backend enabled.
- `claude`/`codex`/agent CLIs preinstalled.
- Browser stack preinstalled (Chromium + Playwright).
- Auth-persistent home volume.
- Default network policy: denylist of known-egress risks; allowlist
  for `anthropic.com`, `openai.com`, configured Git hosts.
- Redaction filter wired to logs.

### Operator ergonomics

- `jjhub ws new --for-smithers <workflow-path>` bootstraps a workspace
  with the preset.
- `jjhub ws attach <wsId>` opens an interactive shell with `smithers`
  on PATH and gateway URL preconfigured.

## Files

- `packages/smithers-runtime-workspace/` (new package)
- `apps/server/src/routes/runtime/*` — webhook for suspend↔lease
- `apps/cli/src/commands/ws/new.ts` — `--for-smithers` preset
- `docs/runtime/jjhub-workspaces.mdx` (maturity: `beta` initially)

## Testing

- Runs the jjhub/0001 conformance suite in CI: must be green.
- E2E: bootstrap a workspace, launch a multi-step Smithers run,
  suspend mid-task, resume, verify the run completes without duplicate
  side effects (cross-check smithers/0019 dedupe).
- E2E: browser automation task succeeds across suspend/resume.
- E2E: auth persistence — `gh auth status` still valid after resume.
- Fault: workspace OOM mid-task → Smithers sees sandbox-unreachable,
  supervisor decides per policy.
- Secret redaction test: write a secret to stdout; verify it's redacted
  in the log stream.

## Acceptance

- [ ] Conformance suite green.
- [ ] `jjhub ws new --for-smithers` boots a working environment.
- [ ] Suspend/resume preserves auth, VCS pointer, and browser state.
- [ ] Lease ↔ suspend webhook handshake documented and tested.
- [ ] Docs published at `docs/runtime/jjhub-workspaces.mdx`.

## Blocks

- Depends on jjhub/0001.
- Unblocks smithers/0022 rows 19–23 and jjhub/0004.
