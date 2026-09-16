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

Exit: seam tests with doubles for every route and the degraded 403; card
tests per status and per facet; T1 spec against a fake cloud upstream that
opens a workspace, streams starting→running, lists snapshots, and refuses a
workspace act on a degraded session with the exact wording. Never fake a
route the backend lacks.

