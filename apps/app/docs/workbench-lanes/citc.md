# Lane `citc` — the workspace card (persistent cloud computer)

Brief: `../decisions/0002-citc-sandbox-kinds.md` (facts and what exists),
`../WORKBENCH-UX.md` §3.1 (anatomy, minus the Desktop facet, which waits on
plue Phase B). Depends on lane `piper` (cloud proxy, sign-in, repositories
tree, working copies) and lane `runs` (both landed). Laws as every lane.

Decisions taken for this lane (will's two open calls, recorded as
reversible defaults in the ADR): (a) no environment or image picker in the
card; kind and environment come from the repo's `.smithers/environment.nix`
and a repo with none offers `container` only, stated in words; (b) Fork and
Snapshot sit on the card footer beside Suspend/Resume, and the Snapshots
facet lists them.

Scope, in order:
1. Shared schemas (`packages/rpc/src/Cards.ts`, `packages/rpc/src/Workbench.ts`
   or the existing shared module the lane finds): `workspace` card payload
   (id, repo, name, targetBookmark, status pending|starting|running|
   suspended|stopped|failed, provisioningStage, bookmarkHead { changeId,
   commitId } | null, snapshots[], sessions[], facet), `service-log` card
   payload. No kind, no uptime, no workspace head, no ahead/behind (plue#446).
2. `WorkspaceSeam` over `/api/cloud/…` (per-repo and per-user list, get,
   create-or-reuse per bookmark, delete, suspend, resume, fork, snapshots
   create/list/delete/template, sessions list/destroy, SSE status stream via
   poll or EventSource through the proxy); a `workspaces` collection that
   also feeds the `workingCopies` rows piper added (kind workspace, state).
3. `workspace` card: header `repo · bookmark · bookmark head @ <id>` with
   the six-state pill; facet strip Terminal / Files / Services / Snapshots;
   Terminal reuses the existing xterm tab kind over plue's ticketed
   WebSocket (a `workspaceId` on the row instead of `cwd`); Files reuses
   `files.list` / `files.read` with the workspace as target; Files and
   Services render EMPTY with the ADR's wording until plue#449; Snapshots
   rows name · taken at with Fork from / Save as template / Delete (confirm);
   footer Suspend or Resume, Fork, Snapshot, Delete (typed confirm), maximize.
   Starting streams provisioningStage into the body; failed shows plue's
   reason and Retry.
4. Flows `workspace.open [bookmark] [repo]`, `workspace.view <id>`,
   `workspace.terminal`, `workspace.suspend|resume` (confirm for agent),
   `workspace.fork [name]` (confirm), `workspace.snapshot [name]` (confirm),
   `workspace.snapshot.delete <id>` (confirm), `workspace.template
   <snapshotId> <name>`, `workspace.sessions`, `workspace.session.destroy`
   (confirm), `workspace.delete <id>` (typed confirm), `workspace.list`;
   slash payloads; registry, parity, invocable tests. Every workspace act
   renders "sign in again to enable" when the cloud session is `degraded`
   (piper exposed `scopes: "degraded"`).
5. Tree rows: a workspace row under its repo reads `name · state`; selecting
   it makes it the active working copy (piper's `org/repo#copyId`).
6. Docs: LOCAL-APP.md cards section; WORKBENCH-UX.md §3.1 status note.

Exit: seam tests with doubles for every route and the degraded 403; card
tests per status and per facet; T1 spec against a fake cloud upstream that
opens a workspace, streams starting→running, lists snapshots, and refuses a
workspace act on a degraded session with the exact wording. Never fake a
route the backend lacks.
