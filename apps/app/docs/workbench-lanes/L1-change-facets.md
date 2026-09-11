# Lane L1 — Change card facets against live plue routes (2026-09-02)

plue-0c reports every route below deployed in production (API 1f8b9e2a909b). The
change card (`cards/ChangeCards.tsx`, seams `state/seams/ChangeSeam.ts`,
`LandingsSeam.ts`) renders degraded wording where these shapes were missing.
This lane replaces the degraded wording with real data. Design: ADR 0003
(`docs/decisions/0003-change-unit.md`) and ADR 0004 (`0004-review.md`), and
the earlier `change.REPORT.md` / `review.REPORT.md` for what is stubbed.
Laws: apps/app/AGENTS.md (no useEffect, collections via dispatcher, every act a
flow with data-flow, NO INVENTION: a missing field renders nothing or the
server's words, never a guess; no user-facing scores, confidence as a word).

## Routes and fields (read them first, then write the seam parsers with tests)

1. `revisions[]` on the change GET with `parent_commit_id`, `source`,
   `provenance` (#450). Diff facet: two revision pickers, `GET
   /api/repos/{o}/{r}/changes/{id}/diff?from=&to=` with interdiff semantics
   (#451). Default `parent → current`; "since my last review" pins `from` to
   `last_reviewed_seq` (#453). Head-moved by commit id stays.
2. Findings per revision (#454) with analyzer state headers; row actions
   `Please fix` (confirm; dispatches the agent on that finding, a run card
   follows) and `Not useful` (records feedback; row dims, reads `not useful`).
3. Checks per revision (#452): `targets_affected`, `ran`, `cached`, duration,
   and `Open the computer` (forks the revision's snapshot: `POST
   /workspaces { snapshot_id }`; a revision may carry a snapshot id with no
   live workspace, so the button exists iff `snapshot_id` is present).
4. Review facet (#459): `reviews[]` with `reviewer_kind`, `verdict`,
   `confidence_bucket` rendered as a WORD, `last_reviewed_seq`; the three-bit
   header strip from ADR 0004; `turn { party, actor, since, reason }` (#460)
   on the header pill row.
5. Threads (#461): states open / done / resolved, actions Done, Ack, Reopen,
   `resolved_in_revision`; the landing gate's open-thread block reads on the
   Land button (`2 threads open`). Stale and moved threads and findings are
   never hidden.
6. History (#450, #464): per-revision source and provenance, and `landed {
   at, by, approved_by[] }` as the last row.
7. Walkthrough facet (#465): renders when a walkthrough artifact exists for
   the current revision; otherwise the facet is absent (not "coming soon").
8. Owners (#467): `owners { touched_paths[] { path, owners[], agent_policy,
   satisfied_by? }, missing_approvals[] { path, candidates[] } }` → Owners
   facet, header strip third row, deny on the header and as the Land reason,
   Suggested reviewers slot filled from candidates; teams by name only.

Where a route answers with a shape that differs from the above, parse what it
actually returns, render that, and record the mismatch in the REPORT (field,
expected, observed). Do not stub around it.

## Tests

Seam parser tests per route (real JSON fixtures copied from what the route
returns; if you cannot reach production from the test, take the shapes above
verbatim and mark the fixture `unverified` in the REPORT). Card tests: each
facet with data; each facet with the field absent renders nothing invented;
the Land button names the block; Please fix confirms; Not useful dims. Extend
`ChangeCards.test.tsx` / `ChangeSeam.test.ts`; keep every existing test green.

## Verification

`cd apps/app && bun x tsc --noEmit -p . && bun test src/mainview/cards/ChangeCards.test.tsx src/mainview/state/seams` then the full `bun test src` once (3 fixture failures in TargetGraph.integration.test.ts are pre-existing; do not touch them). Write `L1-change-facets.REPORT.md`.
