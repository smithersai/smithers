# Lane L1 — Change card facets against live plue routes — REPORT

Brief: `L1-change-facets.md`. ADRs 0003 / 0004. Status: the eight items are
built against plue's deployed shapes; every degraded "(plue#45x)" wording on
the change card is gone except split-ready and revert (out of the brief's
eight, see "Left unbuilt"). Gates: `tsc --noEmit` clean; the lane's suites
354 pass / 0 fail; the full `bun test src` 1650 pass / 13 fail, all 13
outside the lane (below).

## Shape source

I could not reach production from the tests. Every fixture was taken from
plue's response structs at the deployed API commit: `1f8b9e2a909b` is an
ancestor of the local `~/plue` HEAD (`31957d42`), so
`internal/services/{change,landing,ownership,change_walkthrough,commit_status}.go`,
`internal/routes/{jj_vcs,landings,change_walkthrough}.go`,
`internal/db/{models.go,changes.sql.go,landings.sql.go}` and
`cmd/server/router.go` are the record. Source-verified, not observed on the
wire: **every fixture below is `unverified`** in the brief's sense.

## Files changed

Lane files:

- `apps/app/src/mainview/cards/ChangeCards.tsx` + `ChangeCards.test.tsx` (36 tests)
- `apps/app/src/mainview/state/seams/ChangeSeam.ts` + `ChangeSeam.test.ts` (50 tests)
- `apps/app/src/mainview/state/seams/LandingsSeam.ts` + `LandingsSeam.test.ts` (`prs.land` now sends `commit_id`; 4 land tests)
- `apps/app/src/mainview/state/AppController.ts` — the change-seam wiring only (nine new actions, `createChangeSeam(seamCtx, { viewWorkspace })`); the change controller lives here, not under `state/controller/`
- `apps/app/src/mainview/flows/Flows.ts` — the change / review / findings flows only
- `apps/app/src/mainview/flows/SlashPayload.ts` — their grammar only
- `apps/app/src/mainview/styles/cards.css` — one change section (`.change-pins select`, `.change-finding--dimmed`)

Schemas and pins the lane had to move (the card payload is validated by
`CardSchema` on persistence, so the shape lives in `packages/rpc`):

- `packages/rpc/src/Changes.ts`, `packages/rpc/src/Cards.ts` (change card payload block + imports only), `packages/rpc/src/Changes.test.ts` (the verdict fixture)
- `apps/app/src/mainview/flows/registry.test.ts` (the registered-names pin: nine names after `change.facet`)
- `apps/app/src/mainview/flows/parity.test.ts` (`ChangeCards.tsx` affordance count 8 → 16)
- `apps/app/e2e/playwright/change.spec.ts` (fixture to the live shape; the History / rev-pin assertions) — **not executed**: playwright boots the app's web server and the lane forbids launching the app

`Cards.ts`, `Flows.ts`, `SlashPayload.ts`, `registry.test.ts`, `parity.test.ts`,
`cards.css` and `AppController.ts` also carry other lanes' uncommitted edits;
this lane's edits are confined to the change blocks. Nothing is committed.

## What the card renders now

Also: `change.resolve` now POSTs `/changes/{id}/conflicts/resolve { path }`
(#455 exists) and names the agent session; `change.land` and `prs.land` send
`{ commit_id }` (mismatch 17); the stack line drops "by request order" when
the change GET states `stack.position`, and adds `N of M landable` from
`landable_prefix`.

## Route / field mismatches (field · expected per brief or ADR · observed in plue)

| # | Field | Expected | Observed | Rendered |
| --- | --- | --- | --- | --- |
| 1 | `revisions[].provenance` | a `provenance` field | none; provenance is `source` (`push` / `agent` / `revert` …) + `agent_session_id` + `workspace_snapshot_id` + `operation_ids[]` | those, verbatim |
| 2 | `turn.actor` | `actor` | `actor_id` (a numeric user id or an agent-session UUID, as text) | `turn: <party>` only; the id is not a name |
| 3 | `stack.landing_request_id` (change GET) | the landing number | the landing request's DB id (`landing_request_changes.landing_request_id`), unusable in routes | the number still comes from `GET /landings?limit=100`; `stack.position` / `size` from the change GET replace the request-order inference |
| 4 | `reviews[].verdict` | `lgtm` / `concerns` for an agent | `changes.sql.go` aliases `lrr.type AS verdict`: `approve` / `request_changes` / `comment` for both kinds (the agent's lgtm→approve, concerns→request_changes mapping happens at write time) | plue's word verbatim: `agent approve at rev 2 (low confidence)` |
| 5 | `reviews[].reviewer` (agent) | a name | the agent session UUID (or `agent`) | verbatim |
| 6 | threads `state` | `open` / `done` / `resolved` | `LandingCommentResponse` embeds the row (`json:"state"` = lifecycle) and adds `ThreadState json:"state"` (anchor `current` / `stale` / `moved`); Go's encoding/json lets the shallower field win, so the JSON `state` key is the ANCHOR. The lifecycle is on `done_at` / `resolved_at` (Done sets `done_at`, Ack sets `resolved_at`, Reopen nulls both). `resolved_in_revision` is `{ commit_id, seq }` | lifecycle from the timestamps when the row states them, from `state` when a server spells it there, else nothing; anchor from `state` |
| 7 | thread author | a login (`will`) | `user_id` only | no author |
| 8 | `blocked_by` thread block | `{ kind: thread, count }` on the landing | the list's `blocked_by[changeId]` carries `check` / `review{name:"approval"}` / `conflict` only; `thread`, `review{missing}`, `owner`, `agent_policy` appear in the 422 `landing_blocked` details and `auto_land.waiting_on` | `N threads open` counted from the thread rows with plue's own rule (`state <> 'resolved'`); the list's blocks in their own words |
| 9 | `blocked_by` shape | per change | `map[change_id][]LandingBlock { kind, name?, repo?, missing?, count?, path?, candidates? }` | parsed per field |
| 10 | Findings `Please fix` / `Not useful` | a dispatch route; a feedback route | none: `router.go` exposes only `GET …/findings[?rev=]`; `UpdateFindingFeedback` exists in `internal/db` with no HTTP route; no dispatch-on-finding route | both flows refuse naming the missing route; a finding whose `feedback` is already recorded dims and reads the word |
| 11 | findings row | `summary`, `raisedAtSeq` | `text`, `seq`; plus `commit_id`, `source`, `side`, `suggestion?`, `anchor_hash?`, `feedback?`, server `state` `current` / `stale` | mapped |
| 12 | checks per revision | a per-revision route | none: statuses are per commit (`GET /commits/{ref}/statuses`); rows carry `targets_affected`, `targets_ran`, `targets_cached`, `duration_ms`, `workspace_id` (UUID or null) | statuses at the chosen revision's commit; the work line only when any field is > 0 (a row of zeros states no work) |
| 13 | walkthrough | `{ sections, quiz }` per revision | `{ sections[] { title, markdown, diagram? }, quiz[] }`; `?rev=N` optional (0 = newest); 404 `walkthrough not found`; no `seq` in the body | the requested seq is recorded on the card |
| 14 | `owners.touched_paths[].owners[]` | `{ login \| team }` | `Principal { login?, team?, role, reasons[] }` plus `package`, `packages[]` per path; top level also has `required_approvers[]`, `suggested_reviewers[]` | names only; both extra lists rendered |
| 15 | diff pins | `from=<seq\|parent>&to=<seq>` | exactly that; `to` must be a positive seq (`current` is not a server token) | the seam maps `current` to `current_seq` |
| 16 | `current_seq` | the current revision | `0` when the current commit is not a recorded revision | null → no `rev N of M`, pins refuse by name |
| 17 | `PUT /landings/{n}/land` | (unchanged) | now REQUIRES a JSON body `{ commit_id }` (`decodeJSONBody` → 400 on an empty body; `resolveLandingRevision` → 422 `commit_id missing_field`), so the pre-lane `change.land` and `prs.land` failed against prod | both send the current commit: `change.land` re-reads the change; `prs.land` reads the request's tip change |
| 18 | `GET /landings` rows | readiness fields | list rows DO carry `turn`, `auto_land`, `landable_prefix`, `blocked_by` (`populateLandingReadiness` runs for the list) | used |
| 19 | conflicts | the conflicts route | the change GET also carries `conflicts[] { path, state }` | the DTO's list wins; the route is read only when the DTO lacks the key |

## Tests added (by name)

`ChangeCards.test.tsx` (36; new or reshaped):
the header reads rev N of M and turn: <party> … · the review strip: the agent's verdict with its confidence WORD, the human approval with revisions since, the owners line · the diff facet's two pickers pin the interdiff through change.pins; since my review rides review.since-mine · the history facet renders each revision's provenance, Diff to current, Open the computer iff a snapshot exists, and the landed row · the history facet with no revisions and no landed row states the empty fact — nothing invented · the findings facet renders the analyzer runs, each finding …, Please fix, and Not useful · unread findings say so with the reason; a read, empty list states the empty fact — never 'don't exist yet' · the checks facet renders one row per context with its work, the revision picker, and Open the computer iff the revision carries a snapshot · the review facet renders the verdict rows and the threads with their glyph, anchor token, done revision, and one-click Done / Ack / Reopen · a thread whose lifecycle the server did not state renders no glyph and no act · the Land button names the gate's block: open threads and the landing list's blocked_by · the owners facet lists each touched path … · the walkthrough facet exists only when an artifact does, leads for a large agent revision, and renders its sections · the stack line labels an inferred position as by request order and drops the label for the server's own; the landable prefix rides when stated · (diff card) a revision pair reads rev N → rev M and the pin names its revision.

`LandingsSeam.test.ts`: PUT …/land names the tip change's commit_id, is accepted (202), and the re-read card states "queued" · a land whose tip commit can't be read PUTs nothing and says so (plus the two retained land tests re-shaped for the pre-land read).

## Gates

- `cd apps/app && bun x tsc --noEmit -p .` — clean (e2e is in the tsconfig include, so the spec typechecks).
- `bun test src/mainview/cards/ChangeCards.test.tsx src/mainview/state/seams` — 354 pass / 0 fail / 1358 expect().
- `bun test src` (once) — 1650 pass / 13 fail / 1663 across 173 files. The 13: the three pre-existing `TargetGraph.integration.test.ts` fixture failures (`~/artsy/force`), and ten in `src/bun/Main.test.ts` (`the native main process printed no report (exit 143)` at its 5 s probe deadline — it spawns the real electrobun main process through `e2e/native/MainProcess.ts`). Those ten touch nothing in this lane; I did not re-run them because the probe launches the native app, which the lane forbids.
- `packages/rpc`: `bun test` — 131 pass / 0 fail.
- Playwright `change.spec.ts`: updated, not run (same rule).

## Left unbuilt, with the reason

- **Please fix / Not useful**: no routes (mismatch 10). The buttons exist and the flows refuse naming the missing route; nothing is recorded or dispatched.
- **Request review** from the Owners facet (`review.request <changeId> <login>`, ADR 0004 row 10): plue has no reviewer-request route; the slot lists names only.
- **`change.revert`**: still refuses. `POST /changes/{id}/revert` exists (201) but is outside the brief's eight items and its response struct was not read; the refusal wording still says "(plue#456)" — stale, flagged here.
- **`change.split-ready`**: still refuses; plue has `landable_prefix` (#452) but no changeset split route.
- **Auto-land** (`change.land-when-green`, `change.cancel-auto-land`): `POST/DELETE /landings/{n}/auto-land` exist; not in the brief's eight items, not built.
- **Walkthrough story renderer**: sections render as title + markdown text + diagram source and the quiz count; the `apps/review` interactive story (rendered Mermaid, quiz) is not embedded.
- **Findings `Open`** (diff at the finding's line pinned to its revision) and the **Operations / undo** facet (#457): not in the brief.
- **Thread authors**: plue's comment rows carry `user_id` only, so no name renders.
- **Namespaces `review` / `findings`** in the slash menu are synthesized by `registry.ts` (label = id, empty summary); `registry.ts` is not a lane file, so no rows were added.
- **`stack.landing_request_id`** is not used (a DB id); the landing number still needs the list read.

