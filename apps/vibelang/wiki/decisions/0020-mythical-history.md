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
- Evidence is a message's `Validation`, `Tests`, `Regression`, `Before` and `After` paragraphs, each with the lines it
  wraps onto. Every note is whole sentences: a long one keeps the sentences that fit in 300 characters and is never cut
  mid-sentence (a first sentence up to 1,000 is kept whole). `test/seed.test.vibe` checks every note of the seed.
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
GET  /api/history                                  the outline: epics with counts, work not landed, main
GET  /api/history/epics/<e>?from=<n>               50 of an epic's commits in stack order, from the n-th
GET  /api/history/commits/<m>                      one commit in full: its notes and the real commits it folds
GET  /api/history/search?q=<text>                  at most 100 commits whose title has the text, or whose id it is
GET  /api/history/events?after=<seq>               Server-Sent Events, as a conversation's (0010)
POST /api/history/<plan|start|note|approve|fold>   200 {id, folded} | 409 {refusal} | 403 forbidden | 503 unavailable
```

**Read by page.** A reader asks only for what it shows (`src/history/pages.vibe`): each page is a pure function of the
history, computed in the History object beside it, and carries the `seq` it reflects. A follower reads only the events
after its cursor (`Store.since`), never the snapshot again. Before (production, 2026-11-07 23:10 and 23:34 PST): one
read of 2,740,828 bytes (567,902 gzipped) in 0.28 to 3.2 s. After: the outline is under 16 KiB, an epic's page and
a commit under 32 KiB each (`test/pages.test.vibe` checks VibeLang's own history; `test/history.workerd.test.vibe`
the routes).

`LiveMythical` is the `Mythical` layer over it. A live Fold reads GitHub's commit list of `smithersai/vibelang`
(`worker/MainLog.vibe`, at most ten pages of 100) and walks first parents back to the last folded commit; a merge's side
commits the pages hold come before it, and one already folded is refused `duplicate`. `GITHUB_TOKEN`, when the
deployment sets it, raises GitHub's rate limit. Authorization is itself a journaled step, so a refusal is on the record
as an acceptance is.

**Observability.** `vibelang.history.<step>` logs and `vibelang_history_steps{step, outcome}` counts, the flows'
`vibelang.history.*` spans, and the API's `vibelang_api_requests{route}` with `history-outline`, `history-epic`,
`history-commit`, `history-search`, `history-events` and `history-write`. None carries a title, a task, a note or a name.

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
the outline, then each epic's pages, a commit, or a filter's matches as they are shown, and follows events from the
outline's `seq`; each event reads the outline again, one read at a time, and with it what is shown. Each button runs a flow
through `Mythical`, which the page selects as the chat selects `Factory` (live when `/api/health` says so, else the
mock, downloaded only then). Where the reader is lives in the hash: `#e4` an epic, `#m12` a commit, so links and Back
work.

- **List:** epics as collapsible cards with their counts, 50 commits a page with Show more; open work on top
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
like any agent. Live, the server decides who asks.

**The agent in the chat** has the same four as tools (`worker/HistoryTools.vibe`, `src/history/tools.vibe`), bound into
smithers.sh's agent as flows, as the tour's pane tools were: `vibelang/history/show` reads one page (`outline`,
`epic`, `commit`, `search`), and `vibelang/history/Plan`, `Start` and `Note` run in the History object's engine, which
checks who asks. There is no tool to approve or fold. A tool call is a journaled step of the reply; a write reaches the
History object through its internal `act`, as `CHAT_AGENT`: the agent for the person who posted, a viewer until 0019
lands, so its writes are refused `forbidden` as that person's would be. No request reaches `act`. At most eight calls a
cell (`REPLY_CALLS`); `vibelang_history_tool_calls{tool, outcome}` and `vibelang.history.tool.<tool>` logs count them,
with no text. The mock's scripted agent answers a question about the history (`mythical`, `history`, `epic`) by
running `vibelang/history/show` as a step over the mock history, built only when first asked. When lane `vl-actions`
lands its slash commands, the chat reaches these flows through them too (FLOW-3).

```sh
vibelang-factory --json history --commit m4
vibelang-factory --json history --epic e4 --from 50
vibelang-factory --json history --search "computed-key"
vibelang-factory plan "fix(compiler): ..." --epic e4 --task "issue 412"
vibelang-factory start m5704 --lane my-lane
vibelang-factory note m5704 --section tried "A cache; it went stale."
```

`--llms` stays compact: its test allows 1,000 characters per command on average (4,689 for six), where it allowed
4,000 for two.

## Proofs

`pnpm verify src/history/mythical.vibe src/history/flowMachine.vibe` (0005's harness) proves, for every input:

1. `seq` advances by exactly one per accepted event; any other event changes nothing.
2. **Linear:** commit ids unique; `(epic, rank)` unique; every commit's epic exists; ranks nonnegative.
3. **A fold never loses a change:** every event keeps every epic, every real commit (as a prefix) and every commit's
   index, id and epic.
4. **Exactly one:** real shas are unique and every `real[i].mythical` names an existing commit, whose id is unique.
5. Non-vacuity (Sol): an admitted fold appends exactly one real commit and moves `main` to it.
6. **No note is lost or rewritten** (`apply`, with `approved`, `noted`, `amended`, `started`, `landed`): every event
   keeps each existing commit's notes as a prefix and appends at most one; a newly planned commit has none.
7. **Who may** (`flowMachine.vibe` `may`, which `roles.vibe` exports): the agent never approves or folds, whatever its
   role; an approval or fold needs a maintainer; any action needs at least its least role (the table below).
8. **Each flow's steps** (`begin`, `authorize`, `canRecord`, `record`, invariant `lawful`): a run is authorized at most
   once; a record step changes the run only after an authorization the caller is allowed, never before it and never
   after a refusal; only a fold records more than once. So the agent never reaches Approve's or Fold's record.
   `flows.vibe` runs this machine: the authorize step journals `authorize(begin(action, principal))`, and every record
   step, including each `fold/<sha>`, runs only when `canRecord` holds.
9. **A fold never runs before its approval** (`foldTarget`, which `Sequencer.fold` calls): defined below.

**"A fold never runs before its approval", precisely.** The property is about the Fold flow, which maps a commit of
`main` onto the stack. A real commit whose message carries `Mythical: m<n>` folds into `m<n>` only if `m<n>` exists
and is `approved` (a person approved it) or already `landed` (an earlier real commit of the same approved change, such
as a merge's side commit, landed it). Otherwise (no trailer, a trailer naming no commit, or naming one still `planned`
or `working`) the fold appends a new mythical commit to the epic of the commit's scope and folds into that; the named
commit is unchanged. A real commit on `main` is never dropped: it lands somewhere, but it never lands an unapproved
commit. Two paths fold into commits no person approved, by design: the **bootstrap**, which replays main's past
through `decide` and folds into commits it planned the step before (that past predates approval), and an
**untrailered** real commit's own new commit, which is planned and folded at once. Before this rule, a trailer naming
a `working` commit landed it (`test/flowMachine.test.vibe`, "folds into the commit a trailer names only after its
approval", failed first).

**Receipts (nyc-01, 2026-11-07).** `pnpm verify`: `src/history/mythical.vibe` **28 verified, 0 errors**,
`src/history/flowMachine.vibe` **9 verified, 0 errors**; the whole app **9/9 files, 119 verified, 0 errors** (228 s). `pnpm verify:broken myth-… flow-…`:
**25/25** executable mutations rejected by Dafny (367.9 s), each failing a contract in its intended function
(`verify/extended_mutations.py`). The eleven earlier ones: rank shift, id and epic guards, the real-commit prefix,
duplicate and missing fold targets, `decide`'s numbering, its fold and approve guards, `hasSha`, `endOf`. The fourteen
new ones (128.8 s): a note that drops earlier notes, a note appended twice, an approval that drops notes, a fold that
clears notes (`myth-note-prefix`, `myth-note-once`, `myth-approve-notes`, `myth-landed-notes`); a trailer folding into
any existing commit, or never into a landed one (`myth-fold-target-approval`, `myth-fold-target-landed`); the agent
allowed to approve or fold, a role one below its least allowed, a contributor approving (`flow-may-agent`,
`flow-may-role`, `flow-least-approve`); re-authorizing a recorded run, authorizing a refused caller, recording
before authorization or after a refusal, an uncounted record, a second record outside a fold (`flow-authorize-once`,
`flow-authorize-refusal`, `flow-record-gate`, `flow-record-count`, `flow-can-record-once`).

Property tests (Effect `Arbitrary`, VL-15) fail on each of the fourteen applied by hand. `test/mythical.test.vibe`'s
properties (400 runs of 32 to 82 intents) check note prefixes and at most one note per event; `myth-note-prefix` is
caught by its case test "keeps every note in order", because random intents rarely note one commit twice.
`test/flowMachine.test.vibe` checks the machine against an oracle written from the roles table (400 random step
orders), `foldTarget` over random histories, the real sequencer's fold (200 random runs), and the flows on the
engine in memory: a history service and a main whose every member dies prove that a refused caller's flow reaches
neither, and the flows reach a record step exactly when the table allows (60 random callers). Two LemmaScript
lowering defects found earlier are reproduced in `verify/bugs/`.

The proof found two bugs before any test did: `apply` accepted a plan into the epic `""` and a fold into the commit
`""`, because the "taken" lookups count `""` as taken. Both are fixed.

**What stays unproved and why.**

- **Transport** (`/api/history`, Server-Sent Events, `LiveMythical`, `wire.vibe`) and the **web page**: Effect and
  HTTP code outside LemmaScript's subset; a protocol proof belongs with roadmap 1b (TLA+), as for conversations
  (0005). `apply` ignoring all but the next event is proved, which is what makes replay and gaps safe; delivery
  itself is tested, not proved.
- **The engine's durability and journal replay** (`@smthrs/engine`, the History object's SQLite and storage): the
  machine proves what each step decides; that a journaled `Run` replays as written, and that a stored event survives,
  is the engine's and Cloudflare's guarantee; `test/history.workerd.test.vibe` runs the flows on the live object in
  local workerd.
- **`Sequencer.vibe`'s Effect shell**: the lock, the store write before publication, opening an epic for an
  untrailered fold, and title truncation. It calls the proved `decide`, `apply` and `foldTarget`; the rest is tested.
- **`trailerOf`** (a regular expression) and **`areaOf`** (scope to epic): LemmaScript 0.6.6 can't lower a RegExp
  (`verify/bugs/regexp.ts`); both are tested.
- **Reading main** (`worker/MainLog.vibe`, GitHub's API): an external system; its first-parent walk is tested in
  `test/mainLog.test.vibe`.
- **The bootstrap** (`seed.vibe`, `scripts/mythical-seed.vibe`): its grouping is a heuristic over git history with
  no specification to prove; every intent it emits goes through the proved `decide` and `apply`, and
  `test/seed.test.vibe` replays the snapshot.
- **The read pages** (`src/history/pages.vibe`: `outline`, `epic`, `commit`, `search`): Map, sort and slice
  projections outside LemmaScript's subset; `test/pages.test.vibe`'s properties check that the pages put back
  together equal the stack and that the outline's counts equal the history's.
- **The git export**: not built.
- **The roles' source** (`Caller`, decision 0019): who the caller is comes from sign-in; the proof covers what each
  role may do, not who has it.

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
