# 0127: Drift runs its gates unprivileged; delete the dormant root setup

Date: 2026-10-29. Applies SCOPE-3 and PROC-17 to repository automation.

The Drift workflow failed its last 1,000 runs on main without running a gate.
Its `Per-commit drift` job only awaited `trusted-drift.yml`, whose first step,
`trusted-ci-setup`, refuses by design: `ACTIVATED = False` until "T-SEC-01
R1–R3 and smithers-3f's setup campaign acceptance" exist. Neither can exist.

- T-SEC-01 R1–R3 are tests of the microsandbox guest helper in
  `packages/backend/microsandbox`, driven through its bundled `msb`. SCOPE-3
  deleted that code on 2026-10-21 (82b5490dbe95). No receipt can be produced
  for code that is gone, and T-SEC-01 never covered CI runners.
- smithers-3f was a seat in the agent org stopped on 2026-10-20. PROC-17: no
  agent carries Will's authority, so no agent can give that acceptance.

## Options

(A) Complete activation. It needs a new T-SEC-01 scope for CI runners, new
receipts, and a person to accept them. Activation would still protect nothing.
On a `pull_request` event GitHub runs the pull request's own workflow files, so
a pull request can edit `drift.yml` to drop the pinned callee, and the hosted
runner user has passwordless `sudo` in any step. A main-pinned setup step cannot
keep branch bytes away from root on a GitHub-hosted runner.

(B) Run the gates in the `Per-commit drift` job, as the CI job runs its own, and
delete `trusted-ci-setup`, `trusted-ci-setup-campaign`, `trusted-drift.yml`,
`trusted-setup-validation.yml` and the generator's `workflowCall`,
`trustedWorkflowRevision`, `trustedSetupRevision` and `TrustedSetupRefused`.
Nothing else used them.

Choose (B).

## Why (B) opens no hole for pull requests from forks

| Property | Before | After (B) |
| --- | --- | --- |
| Drift steps that ask for root | 1 (refused) | 0 |
| Token | `contents: read`, not persisted | `contents: read`, not persisted |
| Secrets referenced | 0 | 0 |
| Who controls the steps on a fork PR | the PR (it can edit `drift.yml`) | the PR |

- Drift runs no `sudo`, `apt-get` or `sysctl`. Its gates need no system
  package: on Latitude, as an ordinary user with a failing `bwrap` shim first
  on `PATH`, every gate ran and none invoked `bwrap`.
- GitHub gives a fork's `pull_request` run a read-only `GITHUB_TOKEN` and no
  repository secrets. Drift declares `permissions: contents: read`, references
  no secret, and checks out with `persist-credentials: false`.
- The runner is a disposable VM. Root there reaches only that VM, exactly as in
  `ci.yml`, which has installed `bubblewrap` with `sudo` on every pull request.

No trust boundary in `AGENTS.md` moves: no secret enters the run, no system
flow becomes overridable, and nothing ships with a known hole switched on.

## Guards

`packages/repo-targets` `drift-job` asserts the job reporting `Per-commit drift`
runs every gate itself, with no `needs`, no step before checkout, only pinned
third-party actions and no root. It also fails if any workflow references the
deleted setup. The `GithubCiGen` suite renders the drift shape and asserts the
schema no longer has the removed attributes.

Only a hosted GitHub run proves the runner image, `pnpm` cache and wall time.
