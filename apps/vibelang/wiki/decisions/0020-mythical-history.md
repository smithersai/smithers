# 0020. The mythical history

**Status:** accepted, 2026-11-07; Will may override. **Rulings:** VL-22 (and VL-9, VL-11, VL-13, VL-17, VL-18, VL-21);
Smithers D-09a, D-20; repository rules FLOW-3, "people merge; agents never approve or merge". **Brings back** what
`apps/mvp/docs/rulings.md` TODO-2 deferred, for this app only. **Designed twice:** Claude Opus
(`~/vl/mythical/design-opus.md`) and Codex Sol (`~/vl/mythical/design-sol.md`), independently; Opus merged them. **Built:** the machine and its proofs, the bootstrap, the flows, the mock, the live History object
and its routes, the agent's commands and the view.

**Decision.** VibeLang's mythical history is a second state machine beside the conversation's (0003): one linear stack
of mythical commits grouped into epics, written only by its sequencer in one Durable Object, `History`, bootstrapped
from every commit reachable from VibeLang's `main` and the merge queue's records, and advanced only by the flows below,
which people and the agent run alike.

```
issue ─▶ task ─▶ Plan (append | insert | amend) ─▶ Start (lane) ─▶ Note* ─▶ Approve (a person) ─▶ merge queue ─▶ main
                    planned                         working                  approved                          │
                                    landed ◀── Fold: each new commit of main maps onto exactly one mythical commit
```

## What it is and where it lives

- **The store of record is the app's History object** (`worker/HistoryObject.vibe`), the "stack service" D-09a names:
  a sequencer exactly like a conversation's: `decide` numbers intents, `apply` folds events, each event is stored
  before anyone sees it and published to followers. The mock runs the same sequencer over memory
  (`src/history/Sequencer.vibe`).
- **The data** (`src/history/mythical.vibe`, no Effect, proved): epics (appended only); mythical commits, each with a
  stable id `m<n>`, its epic, its rank inside the epic, its title, its state (`planned`, `working`, `approved`,
  `landed`), its open task and lane, and its notes; and `real`, every commit of `main` in order, each with the one
  mythical commit it folds into. The stack's order is (epic order, rank): an insert shifts the ranks after it, so
  nothing is spliced and the order stays strict.
- **Notes** hold what a rebase would lose: `tried` (queue attempts that were rejected, superseded or withdrawn, with
  their reasons; reverts), `evidence` (how it landed; the message's `Validation`, `Tests`, `Regression`, `Before`,
  `After` lines; a person's approval), `superseded`. The view shows a fourth section, `Folded`, derived from `real`,
  so it can't drift.
- **The git export is not built.** A `mythical` bookmark plus `refs/notes/mythical` in VibeLang's repository is
  derivable from this state at any time, because every mythical commit lists the real commits it folds. Sol's
  conditions for building it stand: an atomic multi-ref compare-and-swap through a jj-backed SDK service (no git CLI),
  planned commits as empty reservations, and tree equality checked by a repository action, never asserted by a payload.

## Bootstrap

`pnpm mythical-seed` (on nyc-01, `scripts/mythical-seed.vibe`) reads every commit reachable from `main@github` and
`~/vibe/mq/queue.jsonl`, resolves each queue entry's commits to titles in the lanes' repository, groups
(`src/history/seed.vibe`), records every resulting intent through `decide` and `apply`, fails if any is refused, and
writes the history they built (`src/history/seed/vibelang.vibe`, generated, never edited).

- Each first-parent step of `main` is one bucket; a merge's side commits fold into the merge's mythical commit
  (Sol), so **every reachable commit** maps to exactly one: 6,737 real commits on `220b47743b88`.
- The commits one landed queue entry carried form one mythical commit; `chore(docs): regenerate …` folds into the one
  before it; `Revert "X"` folds into X's and adds a `tried` line: 5,703 mythical commits.
- Epics by scope (`AREAS`), in the order the project first touched them: 11.
- The queue lands copies under new change ids, so a commit finds its queue entries **by title**. That is an evidence
  citation, never an attribution (Sol): it only writes notes, and the landing line says "(matched by title)".
- The live object loads the snapshot once, on first start (`vibelang/history/Bootstrap`), so the deployed view shows
  the real history. `test/seed.test.vibe` replays the snapshot's intents and requires the same history.

## The live object and its protocol

`worker/HistoryObject.vibe` keeps the bootstrapped history in its storage in 64 KiB chunks (`base/<n>`, with `base`
written last as their count) and every later event at `event/<seq>`. Its first start runs `vibelang/history/Bootstrap`
once (execution `bootstrap/first-start`); each write runs its flow in the request that asks, as a post does (0011), on
the engine in the object's SQLite. `src/history/wire.vibe`:

```
GET  /api/history                                  the whole history
GET  /api/history/events?after=<seq>               Server-Sent Events, as a conversation's (0010)
POST /api/history/<plan|start|note|approve|fold>   200 {id, folded} | 409 {refusal} | 403 forbidden | 503 unavailable
```

`LiveMythical` is the `Mythical` layer over it. A live Fold reads GitHub's commit list of `smithersai/vibelang`
(`worker/MainLog.vibe`, at most ten pages of 100) and walks first parents back to the last folded commit; a merge's side
commits the pages hold come before it, and one already folded is refused `duplicate`. `GITHUB_TOKEN`, when the
deployment sets it, raises GitHub's rate limit. Authorization is itself a journaled step, so a refusal is on the record
as an acceptance is.

**Observability.** `vibelang.history.<step>` logs and `vibelang_history_steps{step, outcome}` counts, the flows'
`vibelang.history.*` spans, and the API's `vibelang_api_requests{route}` with `history-read`, `history-events` and
`history-write`. None carries a title, a task, a note or a name.

## Flows and their least roles

Roles come from `src/history/roles.vibe`: each flow reads its least role from `HISTORY_ROLES` and its caller from the
`Caller` service, the one place to swap for decision 0019's policy interface when it lands. A refused caller gets
`forbidden`; the history is unchanged.

| Flow | Steps | Least role | Agent |
| --- | --- | --- | --- |
| `vibelang/history/Plan`, `how: append` | `plan/record` (opens a new epic first when asked) | contributor | yes |
| `vibelang/history/Plan`, `how: insert` or `amend` | `plan/record` | maintainer (Sol, designer: they retell others' work) | yes, for a maintainer |
| `vibelang/history/Start` | `start/record` | contributor | yes |
| `vibelang/history/Note` | `note/record` | contributor | yes |
| `vibelang/history/Approve` | `approve/record` | maintainer | **never** |
| `vibelang/history/Fold` | `fold/main`, `fold/read`, `fold/<sha>` per commit | maintainer | **never** |
| `vibelang/history/Bootstrap` | `bootstrap/load` | its host, on first start; no route | no |
| read: `history` | `GET /api/history`, `GET /api/history/events` | viewer | `vibelang/history/show` |

Landing stays the merge queue's: Approve is the person's decision; the lane enqueues the approved commit with a
`Mythical: m<n>` trailer; the queue lands it on `vibe`; the green cut moves `main`; Fold maps it back, into the commit
the trailer names, else as a new commit appended to the epic of its scope.

## The view

`/history` is its own Foldkit program (`src/web/historyApp.vibe`, `historyView.vibe`), the designer's design
(`wiki/designs/mythical/`) as a maximized pane whose − returns to the chat; the chat's top bar links to it. It reads
the history once, then applies its events with the machine's `apply`; a gap reads again. Each button runs a flow
through `Mythical`, which the page selects as the chat selects `Factory` (live when `/api/health` says so, else the
mock, downloaded only then). Where the reader is lives in the hash: `#e4` an epic, `#m12` a commit, so links and Back
work.

- **List:** epics as collapsible cards with their counts, 50 commits each until Show all; open work on top
  (planned, working, approved); a filter over every title; "Folded through `<sha>`" as a badge linking the commit.
- **Commit:** title, state, id, task and lane; its progress (planned, working, approved, landed on main) with Start
  and Approve where the role allows; the note's four sections with `(none)` when empty; its real commits on GitHub.
- **Plan work:** Commit, Epic (or New epic…), Task; Insert before… and Amend… open it from a commit, for a maintainer.
- **Roles:** an action renders only for a role that may take it; a viewer gets no dialog at all. In mock mode the page
  plays `?role=` or the `vibelang.role` key (maintainer when neither says); live, it is a viewer until 0019 lands.

Where the design and the data differ, the data wins: no docs/code/test planes (the bootstrap groups by queue entry,
not by plane), no diff (no trees), no `tree = main` badge (equality isn't checked; "Folded through" is what is known),
no bootstrap budget form (the bootstrap is a deterministic replay, not a model run), and no inline pane in the chat yet.

## The agent's way in

The command registry (0009) gains `history`, `plan`, `start` and `note`, so the CLI, the MCP server and `--llms` reach
the same flows through `Mythical` (FLOW-3, VL-26); the skill shows them. In mock mode their caller is the agent for a
maintainer (`SURFACE_PRINCIPAL`): it may append, insert, amend, start and note, and is refused approving and folding
like any agent. Live, the server decides who asks. The in-chat agent gains these flows as tools with brick 4.

```sh
vibelang-factory --json history --commit m4
vibelang-factory plan "fix(compiler): ..." --epic e4 --task "issue 412"
vibelang-factory start m5704 --lane my-lane
vibelang-factory note m5704 --section tried "A cache; it went stale."
```

`--llms` stays compact: its test allows 1,000 characters per command on average (4,689 for six), where it allowed
4,000 for two.

## Proofs

`pnpm verify src/history/mythical.vibe` (0005's harness) proves, for every input:

1. `seq` advances by exactly one per accepted event; any other event changes nothing.
2. **Linear:** commit ids unique; `(epic, rank)` unique; every commit's epic exists; ranks nonnegative.
3. **A fold never loses a change:** every event keeps every epic, every real commit (as a prefix) and every commit's
   index, id and epic.
4. **Exactly one:** real shas are unique and every `real[i].mythical` names an existing commit, whose id is unique.
5. Non-vacuity (Sol): an admitted fold appends exactly one real commit and moves `main` to it.

**Receipts (nyc-01, 2026-11-07).** `pnpm verify`: `src/history/mythical.vibe` **19 verified, 0 errors** (25.6 s;
the whole app 5/5 files). `pnpm verify:broken myth-…`: **11/11** executable mutations of it rejected by Dafny in
147 s, each failing a contract in its intended function (`verify/extended_mutations.py`: rank shift, id and epic
guards, the real-commit prefix, duplicate and missing fold targets, `decide`'s numbering, its fold and approve guards,
`hasSha`, `endOf`). `test/mythical.test.vibe`'s properties (400 runs of 32 to 82 intents) fail on five further
mutations, each checked by hand. Two LemmaScript lowering defects found on the way are reproduced in `verify/bugs/`.

The proof found two bugs before any test did: `apply` accepted a plan into the epic `""` and a fold into the commit
`""`, because the "taken" lookups count `""` as taken. Both are fixed.

## Alternatives

| Alternative | Why not |
| --- | --- |
| Sol: a real `mythical` bookmark and notes ref as the published authority now, with publication generations | Needs jj on a host (brick 6), an atomic ref seam the SDK lacks, and a GitHub write this app has never been granted. Kept as the export's conditions. |
| Sol: the full task lifecycle (proposed, accepted, checking, queued, integrated, on main, folded) with operation receipts and HumanTask merges | Needs issues (brick 3), sandboxes (brick 6) and a queue adapter that pins candidates; none exists. The four states here map onto a subset. |
| Opus first draft: first-parent commits only | 248 side commits of green-cut merges would map to nothing. Sol's buckets fix it. |
| Grouping by jj change id | The queue lands copies under new change ids: 0 of 6,490 matched. Titles matched 3,954. |
| Splicing an array to insert | Outside LemmaScript's subset; ranks shifted by `map` keep the proof. |
| Replaying 17,668 intents when the mock opens | 2.3 s on Node, blocking the page. The generator replays once and the test re-checks it. |

## What each designer contributed

- **Opus:** the History object as the store of record; ranks within epics; the four-state machine and its proofs;
  the bootstrap from the queue's records; the six flows and the mock's merge queue (approved commits land).
- **Sol:** buckets so every reachable commit maps once; title matches as citations, not bindings; insert and amend
  as maintainer acts; the export's conditions; non-vacuity contracts; "Folded through `<sha>`" instead of a claimed
  "Current".
- **Designer** (`wiki/designs/mythical/`): the GitHub commits page regrouped by epic, the note's fixed sections with
  `(none)`, Plan work's dialog, the follow-work timeline, the empty state's words.

## Not yet, and why

- The git export (above).
- Live writes: until decision 0019's sign-in lands every HTTP caller is a viewer, so Plan, Start, Note, Approve and
  Fold answer `forbidden` live; reads and the mock work.
- A push webhook for Fold, and lane reports as notes: the queue lives on a private server; both need tokens (0019).
- Moving or dropping a planned commit, splitting or reordering epics: no ruling asks; the log has room for them.
- Diffs on a commit's page: the projection holds no trees; the page links each real commit on GitHub.
- Paging: `read` returns the whole history (3 MB of JSON, about 0.5 MB compressed).
