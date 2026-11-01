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
