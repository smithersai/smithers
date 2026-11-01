# Parallel agent development

Owner: Codex GPT-6.1 Sol. Requested 2026-10-31. Implementation evidence and
pushed revisions are recorded in `~/smithers-builders/devx-STATUS.md`.

## Problems and evidence

Ten source workspaces share one jj repository and land independently. The lead
reported duplicate decisions 0131–0134/0137 and migration 0076. Current source
confirms numeric filenames, an explicit migration import/record in
`apps/mvp/db/Database.ts`, and deployed identities through 0079. The target
index records the whole declaration graph (declared globs remain globs, but
file lists authored in PACKAGE.ts change with additions); the device
schema lock stores an epoch (currently 104). Both aggregate unrelated changes.
The installed bootstrap landing helper locks only its checkout, while current
lanes coordinate through `~/smithers-builders/main-push.lock`.

Upstream jj documents that rewriting another workspace's commit makes its
working copy stale. Concurrent operation heads and working-copy operation
ancestry are separate concerns: integrating heads does not itself update the
working copy. Upstream reports include sibling-operation failures during
simultaneous workspace use. Remote test clients reserve finite slots but lack
complete bounded admission, health checks, and interruption receipts.

## Chosen design

1. Allocate/repair new numeric identities against fetched main at landing.
   Preserve every identity already on main; refuse edits to historical
   migration identities. Rewrite only the incoming lane's references and
   validate duplicate numbers and registry membership. Existing numbered
   records and in-flight manual landings remain supported.
2. Resolve generated projections from authoritative inputs after rebase, then
   check them. Avoid handwritten aggregate device epochs where a safe ordered
   derivation exists. Keep schema history and upgrade compatibility intact.
3. Add a dependency-free Node bootstrap module under the repository automation
   directory, using real jj commands. Create source-only short-lived workspaces;
   sync only the invoking workspace; preserve files before stale recovery;
   never update another workspace. Serialize landing with the existing mkdir
   lock and bounded waits, owner diagnostics, and guaranteed cleanup.
4. Land a named change after fetch/rebase, conflict checks and preparation;
   advance main only by ancestry, push, verify remote ancestry, print its id.
   Readiness is established by file/content predicates, never mutable commit ids.
5. Version the farm scripts, diagnose hosts read-only, and add bounded health,
   admission, process-lifetime, and cleanup checks. Never prune unknown scratch
   or another lane's processes. Keep deployment-specific settings external.
6. No local install. Track tool-created workspace state outside source and
   remove only owned, validated resources after landed-content verification.

## Rejected alternatives

Timestamp migration numbers can sort before an already-applied migration when
an older lane lands later; they do not solve the ledger ordering constraint.
Renumbering applied migrations corrupts identity. A new migration runtime is
unnecessary. A new lock convention would not coordinate existing lanes.
Unconditional `update-stale`, resetting a workspace, or replaying a full stale
file tree can lose newer upstream edits. Global cache pruning and deleting
other lanes' scratch cannot prove ownership. Installing every workspace locally
multiplies disk usage and violates the requested source-only boundary.

## Sources and validation

- [jj working-copy semantics](https://github.com/jj-vcs/jj/blob/main/docs/working-copy.md)
- [jj CLI reference](https://www.jj-vcs.dev/latest/cli-reference/)
- [Sibling-operation report #8737](https://github.com/jj-vcs/jj/issues/8737)
- [Stale-copy report #7538](https://github.com/jj-vcs/jj/issues/7538)

Use Node's existing test runner with real disposable jj repositories and local
remotes. Run installed/package-dependent gates on the mini; no installs,
containers, or full suites on the MacBook. Each fix lands independently once
its checks pass. This is repository bootstrap tooling (catalog: repository
flows / `land`), not a product workflow or alternate flow runtime.

## Implemented: identities and schema history

`numbering.mjs prepare` runs before rebase under the shared landing lock. It
renumbers only additions relative to the common ancestor, then changes only
added lines in the lane's diff, preserving historical test boundaries. The
source-only check runs with the existing landing target. Published comparison
appendices and the two historical 0038 decisions are explicitly preserved.

`generated.mjs` captures base/local/main before rebase, merges device schema
history structurally and refuses conflicting fingerprints at the same version.
Database registration moves into a generated static `MigrationManifest.ts`;
Workers still receive exactly the same Effect SQL migration keys. In-flight
lanes may keep authoring imports and records in Database.ts: preparation strips
only those generated sections and rebuilds the manifest from actual files.
Conflicting database service edits remain conflicts.

Catalog entry used for device snapshots: `@smthrs/effect-tanstack-db`. Its new
`snapshot` helper omits the already-derived epoch and sorts history; legacy
locks remain accepted. Runtime epoch calculation and device preparation are
unchanged. No existing Postgres migration or ledger key is renamed.

## Implemented: workspace and landing lifecycle

`workspace.mjs` creates a private child of fetched immutable main, without
installing dependencies. Every mutation coordinates through the legacy mkdir
lock. Waits are bounded; an unknown owner is never assumed dead. It refuses
shared mutable ancestry, so a rebase cannot rewrite another workspace's commits.
A failed fetch/test/push or cancellation releases only this invocation's lock.
Pushing checks local and remote ancestry and emits the full landed commit id.

The real-jj stale regression reproduced an unsnapshotted edit being overwritten
by `update-stale` on jj 0.39.0. The remedy first saves only dirty source and
original bytes (not repository storage or dependencies), integrates the recorded
working-copy operation, updates the stale workspace, then replays the saved
three-way delta. Independent upstream changes survive. Conflicts retain both
visible markers and original saved bytes; landing rejects the markers. An
operation-abandon fixture reproduces sibling ancestry and verifies recovery.
No other workspace is updated, reset, or deleted. Temporary safeguards disappear
after verified landing; removal refuses unresolved safeguards and personal data.

The tool supports file/content readiness predicates on fetched main, with no
polling for mutable commit ids. Tests use real jj repositories and local remotes:
concurrent CLI pushes, interrupted child execution, failed network paths,
readiness, unsafe ancestry, stale edits, deletions, and removal ownership.

## Implemented: bounded farm clients and disk

The versioned clients and installer live under `.smithers/flows/land/farm/` so
all their source files and tests are included by the existing landing target's
input glob. Installation atomically replaces client files beside the existing
state, preserving private host configuration and in-flight script instances.
The mini uploads a unique helper per run; Latitude holds its host reservation
through setup, execution and cleanup. Neither client treats launch as completion.

The mini previously admitted four independent Vitest runs with each runner's
unbounded default worker count. The new helper caps each run at two workers;
this prevents that particular oversubscription. No claim of a faster full app
suite is made: the full app performance run has not been executed. Pure metadata
commands no longer require app database services. Admission and execution have
separate deadlines; a busy or ownerless reservation produces its actual owner
instead of an endless wait. A reused slot must have no live old process group.
Both clients use bounded independent SSH connections instead of a shared
multiplex socket. Their exit paths stop only registered process groups and
remove their private temporary directory; normal completion and cancellation
are covered by a tiny real mini-host fixture. Mac artifact downloads now require
an explicit request. Normal runs keep bounded slot outputs on the mini, rather
than copying video/media onto the nearly full Mac. No local install or cache
prune is introduced.

Read-only Latitude diagnostics found different user-namespace identities for a
current Podman client and existing containers, with the containers' runtime
paths inside already-removed per-test temporary directories. The new services
use a stable mode-0700 XDG runtime and separate farm graph/runroot. Their names
and labels identify the invoking run; cleanup removes only that run's containers
and its database volume. The old shared graph and live containers are untouched.
Namespace entry fails immediately with a stage-specific reason, instead of
waiting 90 seconds for an impossible health check. Detached launches are refused
because they release the host reservation before the remote work completes.

Disk checks run before sync/install and refuse a host below 20 GiB free or above
95% use. During diagnosis one Latitude host filled while the other was already above
the admission limit; measurements are retained in the private STATUS file. The new client correctly refused a live
Latitude smoke run before mutation. No safely attributable stale data was found,
so nothing was pruned. A host operator must resolve disk ownership/capacity
before the new Latitude integration services can be validated live. Source-only workspaces, removal and opt-in media
prevent these tools adding installs or automatic downloads.

The real mini server fixture verified success, failure exit 23, cancellation
exit 143, worker cap 2 and removal of the invocation's temporary files. The
normal client also demonstrated bounded refusal at both 120 and 600 seconds
when all four shared slots stayed reserved. A stale legacy slot remained owned
by a live client; it was not stolen or terminated.

Bootstrap source writes use private working-copy staging and atomic replacement.
They refuse symlink ancestors/leaves, preserve executable mode and do not mutate
another tree through a hard link. Temporary writes stay outside jj snapshots.
Renumbering skips source scans when no identities move. Projection logs separate
generation from checking and record each stage's elapsed time.
