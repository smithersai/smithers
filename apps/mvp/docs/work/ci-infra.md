---
title: Repair main workflow infrastructure
status: blocked
area: ci
owner: codex-ci-infra
updated: 2026-10-29
links:
  - ../rules.md
  - ../decisions/0126-retire-plue-main-mirror.md
  - vibelang-package-migration.md
---

Repair trusted drift and setup image selection, classify native Windows and package failures,
and retire the unused Plue mirror under SCOPE-3. Keep the trusted setup checks and activation
gate intact; do not extend known-red entries. Use the library catalog's @smthrs/repo-targets
contracts and @smthrs/targets workflow generator. Delivery is builder/ci-infra for the lander.

Run 40929999249 selected Ubuntu 26.04.1, image 20261025.179.1, through ubuntu-latest.
The immutable trusted setup requires Ubuntu 24 and checks root-owned executable inventories,
archive-keyring bytes, main ancestry and action source bytes. Pin its workflow and the validation
campaign to ubuntu-24.04; the generator now refuses ubuntu-latest and Ubuntu 26 for trusted setup.
The validation failure on 3b734cb6 is the same image mismatch, rather than a setup source change.
The lander must refresh trustedWorkflowRevision to the corrected callee's pushed main commit.
ACTIVATED remains false: T-SEC-01 receipts and setup campaign acceptance are explicitly pending.
Do not bypass that boundary or claim a fresh hosted campaign receipt from Latitude tests.

The package job's Install jj and Install ripgrep steps in run 40929998769 both conclude success.
The native workflow's install also succeeds in run 40886182941. The bash-startup warning belongs
to the composite action's printed fallback script; it is not an observed failure in these runs.
The package job instead fails before suite selection because vibelang 0.0.8 has no Windows binary.
Minimal reproduction on Windows: `pnpm exec smthrs test '//packages/...' --jobs 2 --known-red .github/ci-known-red.json --verbose`.
The loader reports `vibelang-win32-x64 is not on npm for this version`; that package's public
registry endpoint still returns 404 on October 29. Record this upstream tooling gap here for the
VibeLang migration owner; no compiler workaround, dependency bump or migration-stack edit is made.

The earlier native run has 31 failed Node-host tests, independent of the successful installer:
directory fsync EPERM, unsupported SIGUSR2 and POSIX process assumptions, Docker probe startup,
fixture URL paths and sandbox checkout-root spelling. Convert the TLS fixture URL with fileURLToPath
and retain a real escaped-URL regression. Canonicalize the sandbox root through the guest shell,
preserving rejection of subdirectories, and exercise a real checkout containing spaces and percent.
These are minimal changes in ci-flows' Node-host area and the catalog's @smthrs/sandbox library.
Native Windows revalidation also depends on the compiler artifact; no Windows pass is claimed.
All known-red entries and their expirations remain unchanged.

No current consumer depends on the Plue mirror's contents. Remove its workflow, credential
references and actionlint inputs, and record decision 0126. Regenerate the target index when landing.
The full drift contract's remaining documentation-generator mismatch belongs to ci-repo;
the targets suite's existing pipeline-job roster assertion belongs to ci-build. Neither is skipped.

Latitude receipts: all 113 GithubCiGen tests and all 15 ProviderFetch tests pass. The escaped
fixture URL fails with the old pathname invocation. Generated ci and drift checks pass (three
targets, zero failures). The full targets suite retains its existing roster failure: 2,820 pass,
one fail and three skips. The full Node-host suite has 1,299 pass, nine fail and 11 skips; its
coverage remains below the unchanged 100% gate. The nine failures are in NativeRuntimeRestart,
NodeRuntimeReap.integration and NodeRuntimeSignals.integration: changed bodies are accepted,
reaper journal/readiness is absent, and a readiness assertion consumes emitted INFO logs. These
also fail on Linux, independently of the Windows tool installation. ci-flows owns that repair.

The complete sandbox suite passes: 61 files, 870 tests, 31 existing skips, and 100% statements,
branches, functions and lines. All 15 SandboxWork tests pass, including the new real checkout
case. These are Linux receipts; the fresh privileged campaign and native Windows receipts remain
outstanding. The brief's Sol-review condition (all owned targets passing) has not been met.
