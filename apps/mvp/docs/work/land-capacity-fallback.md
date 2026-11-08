---
title: Landing checks survive farm admission and upload failures
status: done
area: tooling
owner: Codex GPT-6.1 Sol
updated: 2026-11-04
links:
  - ../../../../.smithers/flows/land/projection.mjs
  - ../../../../.smithers/flows/land/typecheck.mjs
  - ../../../../docs/devx/parallel-agents.md
---

Target-index admission treats mini exit 73 or FARM_HEALTH DISK_FULL like exit 7
or CAPACITY_TIMEOUT, logging the reason before falling back to cfbox.

Both checks share jj-tracked staging and cfbox transport. A direct pre-command
R2 upload failure retries once via SMITHERS_CFBOX_RELAY or private latEndpoints;
SMITHERS_CFBOX_VIA explicitly selects relay mode. Relay mode omits dependency
caching. Ambiguous execution POST failures never retry; R2 diagnostics or
uncaught cfbox fetch errors identify failures before execution dispatch.
Retry renames the tree to bypass cfbox's packing cache without another copy.
Execution-start markers prevent retrying an executed command. Staging
is removed on every exit path, and remote checks run outside the push lock.

Typecheck tries mini, Latitude, then cfbox. The shared Cloud CI helpers bootstrap
verified supported Node and pinned pnpm. Cfbox installs the frozen lockfile
at the repository root and runs pnpm typecheck in apps/mvp, requiring the
command's receipt and a successful transport. A type error, failed install,
missing receipt, broken stream or three unavailable clients refuses the land.

Regression tests failed before implementation: disk-full projection, upload
relay retry, third-client typecheck and the workspace lock regression. Injected
runners also cover relay limits, command failures, ignored-source exclusion,
install ordering, failed installs, missing receipts and stale validation.
The first Astra review found ambiguous execution POST retries, missing Node
bootstrap and stale cfbox packing manifests. New regressions failed before
the fixes; the relay also retains the older client's uncaught fetch diagnostic.
Validation: node --test on projection.test.mjs (21 passed), typecheck.test.mjs
(18 passed, one compiler probe skipped without an installed apps/mvp), and
workspace.test.mjs (16 passed). No staging directory or fixture lock remains.

Catalog entries: repository chores in .smithers/flows and @smthrs/sandbox for
remote execution. This is the existing source-only bootstrap helper described
in the maintenance skill: it must run when installed SDK and CLI imports cannot
load. It adds no runtime, dependency, retry service or product action.

Will requested one local commit, exact-commit Astra review, and no landing or
push. Before/after logs and review receipts stay in the requested private
scratch directory; no private deployment settings enter the repository.
