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

1. Allocate/repair new numeric identities against fetched main during explicit sync.
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
4. Gate a named commit without changing the workspace; land after conflict checks;
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

A migration's identity is its number and slug, in either source format. Converting a
published `.ts` migration to `.vibe` is not an edit: `numbering.mjs` lets it keep its
identity when the `.ts` file is gone and VibeLang's parser finds the same statements in
the `.vibe` file (`conversion.mjs`). Only VibeLang's spellings of the same Effect code and
the imports its prelude supplies may differ. Any other change to a published migration is
still refused, and a `.vibe` beside its `.ts` is a duplicate. The landing tool registers a
`.vibe` migration in `MigrationManifest.ts` the way it registers a `.ts` one, under the
same ledger key.

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

## Review receipts

On 2026-11-02 a lane reported "Astra found no issues" with no review in its log,
and a real Astra run then found four P1s. A review is now a receipt the land tool
checks. It applies to `workspace.mjs land` and `commit.mjs --push`. `git push`
by hand skips it: this is a tool check, not a server rule.

```text
review.mjs --rev <revset> --prompt-file <f>
  codex exec -m gpt-6-astra --sandbox read-only          the lane's request, then the tool's
    answer's last line: VERDICT: PASS | VERDICT: FAIL    template and a Review-Manifest line
  ~/smithers-builders/reviews/<change-id>/<session>.json one per commit, mode 600
  ~/smithers-builders/reviews/logs/<session>.log

review.mjs --flow --rev <revset>
  per commit: smthrs flow start review --wait            {repo, commit, verify: true, narrate: false}
    smthrs runs output <run> result                      verdict pass | fail; incomplete writes nothing
  ~/smithers-builders/reviews/<change-id>/flow-<uuid>.json  mode 600, names the run and its project

land
  every non-empty commit in main@origin..@
    touches review-required.txt (read from main@origin)? if not, no review needed
    a receipt for its change id and diff hash, proven by its rollout or its run?
      any FAIL: refuse     a PASS: land     neither: refuse, naming both commands
  land-log.jsonl records each receipt and override before the push
```

**What the land tool checks.** The receipt must name a rollout under its Codex
home's `sessions/`, with a matching session id, one approved reviewer, only a
`read-only` sandbox, and a completed first
review turn whose tool-written manifest line names the commit, change, hash and
repository, and whose final answer agrees with the verdict. A hand-written JSON file, a
borrowed session, a receipt copied from another change and a FAIL edited to PASS
all refuse. The gate runs again on the exact commits at publication, with no
snapshot between it and the push. The verdict is the
answer's last line only; prose never counts, and a session that ends without it
writes no receipt.

**What the land tool checks for a flow receipt.** The project root it names must
still hold the run, and `smthrs runs output <run> result` must answer a completed
`review` run whose pinned target commit is the receipt's commit and whose verdict
is the receipt's (`pass` is PASS, `fail` is FAIL). The tool recomputes the
commit's diff hash from the repository being landed, so a receipt that moves an
old run onto new content refuses. Run state lives in the project's `.flows/`, so
a flow receipt proves itself only while the workspace that ran it exists: review
and land from the same workspace. `runs output` does not name the model that
reviewed, so the receipt records none and the gate checks none; the operator's
`SMITHERS_SEATS` chose it, and only the run's raw `runs logs` events show it.

**Reviewers.** Astra by default. `--model gpt-6.1-sol` when Astra is unavailable; the
receipt records the model the session ran. Fable is not accepted: a Claude session
has no read-only sandbox record and a different format. With both Codex models out,
use the override, or the review flow (`--flow`) on the seats `SMITHERS_SEATS`
pins.

**What it doesn't prove.** This is not cryptographic. Someone who forges a
rollout file too can forge a receipt, and someone who deletes a FAIL receipt
removes it. The lane writes the review request, so it can mislead Astra; the
template tells Astra to treat that request as a description. Astra's PASS is one
model's opinion, not a proof the code is right. Rollouts and receipts are local
files, so review and land on the same host. Until the list is on main, the tool
reads its own copy; a lane could empty that one, once.

**The hash** is built from stored file contents (`jj file show` of each changed
path in the commit and its one parent), with the line diff computed by the tool, never
from `jj diff` text, whose format differs between jj 0.39, 0.45 and 0.46. A test pins
the hash of a fixed pair of trees, so any change to its input fails loudly. It covers
a commit's changed lines, three lines of context and hunk line numbers, so the same edit to a twin block differs. A rebase keeps it unless it
shifts a hunk (a line added or removed above it in the same file) or edits within
that context; then the land asks for a new review. A rebase past edits in other
files keeps it. It ignores what landing rewrites: references that name a migration
or decision the commit adds (its stem, "decision N", "migration N", and a decision's
Markdown heading and links), quoted boundaries in migration tests, and the generated
`target-index.json`, `MigrationManifest.ts` and `schemas.lock.json`. A bare number
in code is content. A reference to a migration an earlier commit in the stack adds
breaks the hash when that migration is renumbered.

**A FAIL sticks to its diff.** A later PASS of identical content doesn't clear
it, because rerunning isn't fixing. The lookup is by repository and hash across
change ids, so a squash can't shed it. Change the code, or use the override and
say why. A receipt holds its session's first review turn: resuming that session
changes neither its verdict nor what it covers.

**A stack's FAIL covers every commit in it.** One `review.mjs` session over a stack
writes the same verdict into each commit's receipt, so a FAIL caused by one commit
also blocks its unchanged siblings, whose diffs keep their hashes. The way out is to
squash the stack into one commit after fixing it: the combined diff has a new hash,
which no FAIL covers, and one review reads it whole. On 2026-11-03 the gate itself
landed this way (06ee77f1): the rebased stack failed on one commit's list gap, and
the squashed fix passed. To keep commits separate, review each with `--rev <change>`.

**Follow-ups cost a new review.** Any fix after a pass changes the hash, so it
needs another session; put "only the change since `<commit>`" in the request to
keep it narrow. Measured on 2026-11-02's Astra reviews: narrow
follow-up rounds took 20,000 to 64,000 tokens, and the median review took 105,000
tokens and 4 minutes (90th percentile 153,000 tokens and 8.5 minutes). A
stack is cheaper as one session over `main@origin..@`, and a separate fix commit
on top needs a review only of itself. In that day's audit four commits changed after
their pass with no new review, and four more landed with an open finding; that is the gap this cost closes.

**Overrides.** `--no-review-needed "<reason>"` lands anyway. It needs a one-line
reason, and each use appends a line to `~/.vibe-orch/proxy/inbox.md` (`HH:MMZ
[land-override] who=... commit=... reason=...`) and to `land-log.jsonl`, once per
commit. `who` is self-reported. It is for false positives and for reverting a bad
commit in an incident, when waiting for a review is the greater risk. It also works
when the receipt store, a receipt or a rollout can't be read, where a normal land
refuses. The inbox line is written first and is mandatory; the land log, kept in
the receipt store, is written after it, and a failure there is reported, not fatal. A Git
checkout has no change ids, so it can hold no receipt and needs the override.

The inbox path comes from the passwd home directory, not `HOME` or any other
environment variable, so a land can't point the line elsewhere. If the file can't
be written the override refuses, and the tool never creates it. So the override
works only on the host that has the inbox, the Mac. On nyc-01, which has no
`~/.vibe-orch`, it refuses; get a receipt there, or land on the Mac.

**One queue.** `commit.mjs`, `workspace.mjs land` and issue-sweep take the same FIFO lease
after the full affected gate. Workspace landing first syncs and regenerates the
target index under the lease, then inspects the receipt, typechecks, validates
and pushes. Both entrypoints retain their final main/source checks. The lock is per host. A land from another host doesn't serialize
with the Mac's; a moved main then fails the push.

**The required list** names the areas where most files decide who may act or what
they may read (`worker/branch`, `github`, `runners`, `personal`, `stack`, `ci`,
`packages/effect-electric/src`), named access checks outside them, the device
store and the land tool. Name a new such file in it. Tests, fixtures and
`schemas.lock.json` are excluded, and migrations match by name, so a migration
needs a matching name to be caught. Against 2026-11-02's 132 landed commits, an
unusually access-heavy day, it requires 48. Adding a path lands through the same
gate, because the list is itself on it.

## The land's typecheck

`workspace.mjs land` or `commit.mjs --push` whose diff touches `apps/mvp` runs `pnpm typecheck` there, covering the app,
worker, infra and evals projects, and `--validated` doesn't skip it. `vibelang -p
tsconfig.json` alone skips worker tests, which let a type error reach main twice
in two days (7ee5a29a, ab1b52fd). It runs on the farm with no local install and
while its FIFO lease is held: `SMITHERS_MINI_RUN` with five seconds of admission, then
`SMITHERS_LAT_RUN` if the mini has no slot or doesn't answer, then cfbox if neither answers.
Cfbox stages only `jj file list` source and sources the Cloud CI bootstrap
helpers to install verified supported Node and pinned pnpm. It runs
`pnpm install --frozen-lockfile` with install scripts at the root after the shared
CI bootstrap, then `pnpm typecheck` in `apps/mvp` with the same receipt, and removes
its staging tree after success, failure or cancellation. A failed install emits
no typecheck receipt. All three clients failing refuses the land. A type error refuses
the land. So does a farm that can't answer: the check counts only if the command's
own `SMITHERS_TYPECHECK_EXIT` line comes back, because a client that skips a
package also exits 0. Rerun when the farm has capacity. `commit.mjs --push` also
binds publication to the tree its checks saw: an edit made after they ran, such as
during validation, refuses the push. Latitude classifies the command as
light, so it needs no heavy-test permit. `mini-run` starts its admission clock after
its health check and sweeps the slots once even with no wait; the target index
also gets five seconds, because an older `mini-run` read 0 as already expired and
sent every land to cfbox.

## The land's affected tests

`workspace.mjs land` and `commit.mjs --push` test the exact stored commit
against its fork point with the observed main, before taking a FIFO ticket or
lease (`.smithers/flows/land/affected.mjs`). A change behind main is valid input.
The gate never syncs, rebases, regenerates files or snapshots the working copy.
Workspace landing syncs and regenerates the index only after admission, before
inspecting the receipt. A rebased head with a newer main proceeds as
`gate: incomplete, stage=main-advanced`. Waiting for the affected gate's farm
capacity holds no publication lease.

A completed run writes a mode-600 receipt under `.jj/affected-receipts/`
(the legacy adapter uses its Git directory), recording the observed main,
immutable head and exact diff hash, including entry types, executable bits and
symlink targets. The gate exports that commit's stored bytes for execution.

After FIFO admission, receipt inspection has three outcomes:

- A refused receipt or proven regression refuses, even if main has since moved:
  the failure was proven on this change's own diff.
- Passed evidence for the same diff and main prints `gate: passed`.
- Everything else proceeds with `gate: incomplete, stage=<stage>`:
  `main-advanced` when main moved, `source-changed` when the diff changed,
  `receipt-unreadable` for missing, unreadable or malformed evidence, or the
  incomplete gate's own stage.

Only proven failure blocks the affected gate. Over 72 h, 67 percent of gaps
between apps/mvp lands were under 12 minutes, so a receipt is often stale by the
time it is read. Stale evidence proceeds with completed proof counts and the
same `land-log.jsonl` and proxy inbox audit used for other incomplete outcomes.
`--validated` remains an annotation; it cannot create a passing receipt.
The existing typecheck, explicit validation and publication protections remain.
Publication requires remote main to be an ancestor of the candidate under the
FIFO lease; a divergent change can still be gated at its fork point.


The affected set is every test target in
`.smithers/target-index.json` whose declared inputs read a changed path, every test target of a workspace package that depends on a
changed executable input by `package.json` (membership as `pnpm-workspace.yaml` declares it; a
version range counts, since `linkWorkspacePackages` links it), and every target depending on one of those, transitively; plus all of
apps/mvp's Vitest files, which no index target declares, when the change reaches
apps/mvp: its files, a package it depends on, an `//apps/mvp` target the index reaches,
or `packages/repo-targets/test-utils`. A shared file (`package.json`,
`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `.pnpmfile.mjs`, the Node version files, a root
`tsconfig*.json`, `patches/`, `.smithers/WORKSPACE.ts` or `.smithers/environment.nix`)
owes every package's tests. `--test` adds commands to
the set and `--validated` records a receipt; neither shrinks it. A change that deletes
or breaks the index or `apps/mvp/vitest.config.ts`, or a config whose `test.include`
isn't one list of plain string literals using `**`, `*` and `{a,b}` in the default
export, each object the whole value and every member `name: value`, set once with no
spread, merge, computed key, getter, method or
projects that could replace it,
leaves the affected gate incomplete. So does a change to a path the farm clients
never copy to a host (`.npmrc`, `.env*`, keys, build output, media): no test there
could see it. These are missing proof, not proven regressions.

Documentation directories, conventional documentation filenames and the generated
target index do not change their enclosing package's runtime. Markdown and text
fixtures/templates remain runtime inputs, including fixture README files.
Their explicitly declared readers still run, including readers declared in apps/mvp,
without activating the full Vitest suite. Whole-tree inventory globs do not spread
these edits to unrelated tests. An index-only edit runs its index contract, without
apps/mvp Vitest; a work-note-only edit selects no tests.
App reach is computed from executable paths separately, so an unrelated code edit
does not promote a documentation reader into the full app suite.

The gate reports `incomplete` when its suites are fewer than the affected set, naming each
missing one; a target smthrs skipped or cancelled didn't run and counts as missing.
Synthetic zero/skip classifications require the runner's flags. Real named
assertions, including marker-text names, always compare normally with the parent. A
failure's identity includes its kind as well as its file and name: a synthetic
parent marker cannot excuse an ordinary assertion with the same title. The runner
tags reserved-looking assertion titles explicitly and retains a separate module
error even when its displayed name matches an assertion.
A Vitest file with zero executed tests blocks only if the change touched it or it ran
tests on the parent. Unchanged files also zero on the parent are listed in
`unchangedZeroTestFiles`. Skip reasons and collection errors retain their separate
identities, so a new collection error is still a regression. A run killed, interrupted, exiting nonzero with no failed test, or with
an error outside any test (the land's own Vitest reporter records those), and a farm
client that fails after printing its `SMITHERS_AFFECTED` receipt or prints none, are
`incomplete` too. A recognized missing-browser error also makes its derived
zero-test, skipped-file and unnamed-file markers inconclusive; independently named
failed assertions remain proof. A proven added failure blocks; INCOMPLETE permits the land to
proceed. It prints the stage and completed target/file/shared-failure counts,
retains incomplete evidence when writable, and records
`gate: incomplete, stage=<stage>` in `land-log.jsonl` and the existing proxy
`[land-override]` inbox line before publication. It never creates a PASS receipt.
The error retains a stage and retry instruction. Both audit destinations must
succeed before publication; an incomplete gate cannot hide a failed land-log write.
A proven regression takes precedence over missing suites or incomplete cleanup.
Completed head and parent proof survives an incomplete sibling or one that ignores
cancellation; partial completed counts remain visible. Parent files that finished
retain their comparison proof when another file lacks a browser. Confirmed shared
failures count immediately. Every acknowledged cfbox outcome is inspected before
an incomplete one propagates; interim output cannot cancel later completed proof.
A parent process that failed without a completed failure identity proves no pass. A failed test
reruns on a base tree, the fork point's paths with each changed one at its bytes,
type and mode, on the client that saw it fail (and the same named Latitude server); a test that fails there too is reported and
doesn't block, and any other failure refuses the land by name. A test is named by its
file and full title, with its place among tests sharing that title; a file's own error,
from collection or a suite hook at any depth (the land's Vitest reporter reads each
module's and suite's errors, which the JSON report drops once a test in the file fails),
is a failure beside any failed test, named by a hash of its text, and a failed file with
neither is never excused. The runner starts Vitest and smthrs by node from their bins,
not through `pnpm exec`, so a test process killed after it reported shows as killed. A failed index target
counts as one failure for all its tests. It is excused only when that same target
fails on the base; failure digests need not match. Parent requests use each target's
declared verb, including `build` for build-only dependencies. A base rerun that crashes
or skips a suite excuses nothing, and a failing file or target main doesn't have is the
change's failure. 38ae4a3b landed with 148
apps/mvp tests red because the lane's validation ran a partial suite list and the land
ran only the typecheck; this gate, applied to it on 4738de93, refuses it.

The land writes the head commit's blobs (`workspace.mjs`: the tested `@`; `commit.mjs`:
its validated tree) into one private snapshot, with their modes and
no export or line-ending filter, and takes the changed paths, both sides of a rename, from that tree and the
fork point with the observed main, selects from it,
sends it to every farm run and builds the base tree from it, so an edit made while a
run waits for capacity can't change what was tested. A jj source exports the full right side of a diff from the empty root,
without creating a workspace, and reads both rename endpoints with `jj diff`.
The legacy Git checkout adapter retains its existing store reader. The snapshot has no `.jj` or
`.git`, so the runner hands `smthrs test` the snapshot's `.smithers` inventory as
`SMITHERS_TEST_TRACKED_SOURCE_FILE`, with `SMITHERS_TEST_SOURCE_MIRROR=1`, and
`packages/smithers`' fresh-clone tests run rather than skip. The farm's slot Postgres comes
as URLs holding the fixture's password, which the workspace's declarations refuse
(`packages/smithers/flows/engine-store/PACKAGE.ts`), so `smthrs test` runs without those
and the targets start their own servers. The index targets run as one farm run per declared `hosts` set
and Docker requirement (including transitive dependencies),
each only on a client of that platform, and apps/mvp's suite as six Vitest shards, all at
once.

Boxable runs use `cfbox parallel`, at most seven jobs per batch. App runs use the pg
image (Postgres, PgBouncer and Electric); metadata-only runs use the base image.
Both install from the lockfile. `SMITHERS_CFBOX_VIA` chooses the relay. Docker-dependent
and explicitly platform-specific targets use Latitude, retaining the same server
and image for parent comparison. The mini fallback has been removed from this gate.

A separate FIFO admission lock (`~/.smithers-lead/affected-pg.lock`, override
`SMITHERS_AFFECTED_LOCK` for independent fixtures) spans an app gate and its parent
comparisons. A waiting gate owns no pg boxes. The **whole gate** has a thirty-minute
wall bound, beginning before selection and content hashing, including admission,
export, upload, install, parent comparison and cleanup. Execution stops with time
reserved for child termination. Admission waits at most fifteen minutes within
that bound; a second gate that cannot get boxes reports INCOMPLETE and proceeds.
No queue wait can extend the whole-gate bound. Both entrypoints pin the stored
commit and observed main before testing at their fork point. Synchronous jj
metadata reads and exports use the remaining timeout alongside the farm clients'
cancellation signal. If hashing times out before the diff is known, incomplete
evidence retains the pinned head. Neither entrypoint prepares source.

Pg admission records each local farm client's PID and process start time in
`external-work.json`. Client exit, including failure or interruption, marks it
stopped; after every client exits, `external-work-stopped` is written before
release. Remote boxes have their own lifetime. If a gate is killed, a waiter
on the same host reclaims it only after the owner and all recorded client
processes are dead, checking recorded start times against PID reuse. Recovery
writes the stop receipt and logs owner PID, client count and proof. A live owner,
a surviving client, an unknown process identity or a remote host retains admission.


## Implemented: workspace and landing lifecycle

`workspace.mjs` creates a private child of fetched immutable main, without
installing dependencies. Admission uses `~/smithers-builders/main-push.lock.queue/`
(or `${SMITHERS_LAND_LOCK}.queue/`). An atomic numeric `mkdir` claim allocates
each ticket; permanent claim directories make the sequence monotonic across
empty queues and crashes. Ticket order never uses mtime. Waiters print their
position and hold no farm slot. The head also takes the legacy `main-push.lock`
directory through validation and push, excluding existing bare-mkdir scripts.
Its owner marker is prepared inside the ticket, then the complete directory is
published by an exclusive rename that never replaces even an empty legacy lock.
This requires Python 3's standard-library FFI for macOS `RENAME_EXCL` or Linux
`RENAME_NOREPLACE`; Node does not expose those flags. Missing support refuses
acquisition. There is no mkdir-to-owner crash gap or ordinary-rename fallback.

`SMITHERS_LOCK_TIMEOUT_MS` bounds queue admission (default one hour), including
validation by landers ahead of us. Both bootstrap entry points use the exported
`defaultLockTimeoutMs` in `lock.mjs`; a healthy validation lasting six minutes
keeps its waiting ticket through publication.
`SMITHERS_LOCK_MAX_HOLD_MS` bounds the holder (default fifteen minutes).
`SMITHERS_LOCK_STALE_MS` is the heartbeat threshold (default one minute), and
`SMITHERS_LOCK_HEARTBEAT_MS` is the refresh interval (default five seconds; it
must be shorter than the threshold). Tickets record host, pid, start time,
hold start and heartbeat. A separate Node heartbeat writer stays responsive
through synchronous checks and exits when the lander's IPC channel closes.

A waiter reclaims a ticket after heartbeat expiry, max hold, or proof its pid
is gone on this host, logging its ticket, host, pid and reason. Remote pids
are never probed. An interrupted ticket initializer is reclaimed after the
heartbeat threshold. Legacy directories without a queue ticket remain untouched;
a file, symlink or other non-directory at the legacy path refuses immediately.
Only this ticket's unique marker can release its legacy lock.

Publication competes atomically with revocation by renaming a prepared, nonempty
decision directory into place. A decision never appears without its contents.
An independent supervisor records the publication process group before granting
permission to execute, and the launcher rechecks ownership and expiry. A lost or
overrun land refuses publication. The supervisor and launcher enforce the
remaining lease, capped at one minute, even if the lander is killed. Recovery
confirms the publication process group has stopped before admitting a successor.
Process observations without arguments or group members are inconclusive;
they retain exclusion and record `publisher-probe`, never prove PID reuse or death.
Stop receipts record their producer, time and proof. The supervisor also closes
its launcher's own IPC endpoint so it can kill its group without a PID probe.
On cancellation or deadline the parent also kills its own supervisor directly,
including a suspended one, then independently confirms the publication group
stopped. `publisher-stop-requested` records the reason code, producer, supervisor
pid and time without command arguments or environment values. Unconfirmed
termination returns an error and retains the ticket and legacy exclusion.
For a remote publication, only its supervisor's stop receipt confirms termination;
a local clock passing the remote deadline cannot reclaim it. A missing receipt
retains exclusion, logs `RETAIN` and leaves waiters subject to their admission bound.
Cleanup atomically retires the legacy directory with its ownership marker before
marking the ticket done, so interrupted cleanup remains recoverable. It first
retires any prepared acquisition source so a surviving helper cannot publish late.
Initialization and retirement contend on the same immutable, nonempty directory:
cleanup either sees the complete source and owner or prevents them from appearing.
This also fences a stalled initializer before the ticket is marked done.
Issue-sweep retries failed publication with a fresh ticket and fresh validation.
Publication also fetches
main again and refuses changed source or a changed base, catching pushers outside
this queue. Explicit sync refuses
shared mutable ancestry, so a rebase cannot rewrite another workspace's commits.
A failed fetch/test/push or cancellation releases only this invocation's lock.
Pushing checks local and remote ancestry and emits the full landed commit id.

The explicit target-index generation command tries mini admission with `MINI_RUN_WAIT_SECONDS=5`.
Exit 7 or `CAPACITY_TIMEOUT`, and exit 73 or `FARM_HEALTH DISK_FULL`, on a failed
attempt route to
`~/.vibe-orch/bin/cfbox` (`SMITHERS_CFBOX` overrides the client). Both hosts
generate and drift-check before returning the same single base64 receipt; only
a valid receipt and unchanged source permit writing the local projection.
Other mini failures remain failures. The metadata job requests 2 vCPUs (8 GiB),
so it does not queue behind the larger 4-vCPU tier. The box bootstraps the repository's pinned
Node and pnpm through the existing Cloud CI target-index gate and runs the
projection helper. The Mac installs nothing. A temporary tree from `jj file
list`, plus cfbox's `--with-deps` directory walker, avoids Git discovery and
excludes VCS storage and ignored files. Staging is removed on success or failure.
Both index generation and typecheck try a cached direct cfbox upload first.
A confirmed pre-dispatch R2 upload failure (cfbox exit 125 with an R2 failure
diagnostic, or cfbox's uncaught `TypeError: fetch failed`) retries
once through `SMITHERS_CFBOX_RELAY`, or the first SSH destination in
`latEndpoints` from the private `farm-config.json` beside `SMITHERS_LAT_RUN`
(default `~/.smithers-lead/lat-run`). With no relay configured, the failure
remains a failure. `SMITHERS_CFBOX_VIA` explicitly selects relay mode from the
first attempt. Relay attempts omit both `--cache` and `--cache-key`, which cfbox
cannot combine with `--via`. The retry renames the disposable staging directory
to bypass cfbox's packing cache without copying source. A generic `upload failed`
is ambiguous: the execution POST may already have run, so it never retries.
The client's execution POST wraps fetch errors as `upload failed`; its uncaught
fetch diagnostic identifies a failure before dispatch. Command-start markers,
command failures and interrupted streams also prevent retries. Disk-full fallback
and relay retries log their stage and reason
without printing private configuration. No host alias is hardcoded here.
The native `smithers-jj-export` helper is unnecessary for this path:
`TargetIndex` uses `GeneratedFile` write/check actions on the build engine's
Node filesystem, and its inventory prerequisite only reads declarations.
Neither acquires the confined `AtomicFileSystem` service or exports a jj tree.
A real cfbox generate/check/receipt run passed with the helper configured to a
nonexistent path.

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


The incomplete policy is a temporary response to the relay's **serialized box
streams** (Node 26.5.0 / Undici 8.7.0), separate from the pg cap of eight. Two
cold-issue shards measured 429.1 s and 382.6 s; a file-tree shard measured
392.0 s. Seven jobs at roughly 400 s each run one at a time (about 46m 40s,
before parent comparison). Both app-reaching gates ended INCOMPLETE at pg
admission; blocking that outcome stops every apps/mvp land, while docs and
index controls pass. Tighten this rule once relay streaming is fixed and the
complete comparison fits the bound. Will will file the relay issue; measurements
are observations, not a throughput guarantee.
