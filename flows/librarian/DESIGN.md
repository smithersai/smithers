# Librarian: the explained Wiki and the retold history

Status: design, 2026-09-14. Supersedes the doctrine in `host.md` ("factual,
deterministic generators", "not inferred documentation").

What shipped first was a per-folder file index and a one-commit snapshot. The tutorial
promises a Wiki that explains the code and a history of how the repository got
here, and the specs describe exactly that (factory-spec 03/07, Mythical Coding
Contract 2026-09-08). This is the first version that makes the product match the promise: model-authored
text that is published only when every claim carries a citation that resolves
at the source revision, and a retold history whose tree equals today's tree.

## Decisions

1. **Model text is allowed, evidence is mandatory.** Both flows declare agent
   seats. No sentence reaches a reader unless a deterministic check resolves its
   citation (`path:line` + exact one-line quote) against a blob at `sourceHead`,
   and a semantic review marks its section supported. Failure publishes nothing.
2. **Reuse the existing review machinery.** `flows/wiki` already reviews page
   sections and validates citations exactly (`flows/wiki/schema.ts`,
   `operations.ts::assess`, `evidence.ts`), and Jev then judges whether each
   exactly resolved citation actually supports its claim
   (`flows/wiki/jev-citations.ts`); an unsupported citation refuses the page by
   name and an evaluator Jev cannot reach fails the step rather than publishing
   unchecked. This work adds the missing *authoring* step; it does not invent a
   second verification story.
3. **Branch stays `mythical`.** The shipped readers (`HistorySeam.MYTHICAL_REF`,
   `HistoryCard`), the acceptance test and plue docs all say `mythical`. The
   `myth` name in the 2026-09-08 contract is recorded as a deviation here rather
   than breaking every reader; renaming is a separate, coordinated change.
4. **Confidence is categorical.** `confidence: 1` disappears. A page carries
   `verified` (every section supported and cited) or it is not published.
5. **Publication is part of done.** A run that writes refs no reader can see is
   not complete: history pushes `refs/heads/mythical` and `refs/notes/mythical`
   to the repository, and plue lists notes refs so the app can read them.

## The explained Wiki

- **Selection** (`wiki/catalog.ts`): prefer `.smithers/target-index.json` when
  present; else modules = directories at depth ≤2 holding a manifest
  (`package.json`, `go.mod`, `PACKAGE.ts`, `Cargo.toml`, `build.zig`) or a
  README. Rank by tracked-file count, tie-break by path. Bound: ≤30 pages total
  = `index` + `start-here` + `architecture` + ≤27 module pages. Record omissions
  on `index` under "Not explained".
- **Evidence** (`wiki/evidence.ts`): per module, read blobs at `sourceHead`
  only (never the worktree): manifest, README, entry files, exported-symbol
  lines. Reuse `flows/wiki` path safety (no `.git`, `.jj`, `.flows`,
  `node_modules`, `.env`, private vaults) and bounds (≤512 KB/file,
  ≤300 KB/page evidence).
- **Authoring** (`wiki/author.ts`): `AgentAction.make("librarian/author-page",
  { seat: "librarian/wiki-author" })` → sections `{heading, markdown,
  citations: [{path, line, quote}]}`. Module page sections: Purpose, Entry
  points, Key concepts, Depends on / Used by, How to change it, Related.
- **Review + verification**: each page runs the existing review action and
  `ValidateReview` semantics. Then `wiki/verify.ts` re-resolves every citation
  against the blob at `sourceHead` (line in bounds, quote is an exact substring
  of that single line). One correction round; a section that still fails is
  dropped; a page with <2 verified sections is dropped and listed as not
  explained; zero verified module pages fails the run.
- **Body** carries what the wire drops (`{id,path,title,body}` only): YAML front
  matter `schema: librarian-wiki/1`, `sourceHead`, `seat`, `confidence:
  verified`, citation counts, and a visible evidence footer. Links are written
  as `[[path]]`, which the publisher rewrites to slugs
  (`gateway_wiki.go:104-113`).
- **Re-run**: slugs embed `sourceHead` (suffix is 16 hex chars,
  `gateway_wiki.go:135`), publication is create-only. Same head + identical
  bytes is a no-op; same head + changed bytes is a conflict surfaced as "a Wiki
  for <head7> already exists; land a change to regenerate". A retried run
  replays its journaled page bytes rather than re-authoring.
- **Visibility**: acknowledged pages are imported into `worldDocuments`
  (`state/controller/librarianRuns.ts`) so a finished Wiki is reachable in the
  app, not only in the cloud mirror.

## The retold history

- **Read** (`history/collect.ts`): `rev-list --reverse --topo-order` + message,
  parents and changed paths per commit. Bounds: ≤10,000 commits, ≤20,000 tracked
  paths, ≤16 MiB evidence; overflow or shallow clone fails explicitly.
- **Epics** (`history/plan.ts`): `AgentAction` (seat `librarian/history-author`)
  proposes 1–12 prerequisite-ordered epics: title, story, ordered member SHAs.
  Deterministic validation: every real commit attributed exactly once; every
  final-tree path assigned to exactly one epic (its last toucher). One
  correction, then fail.
- **Objects** (`history/objects.ts`): build from an empty root. Per epic, 1–3
  single-parent atoms add that epic's assigned paths at **final** content in
  docs → code → tests order; the epic is a merge commit with parents
  `[previousEpicMerge, lastAtom]` and the atom tip's tree. This is a retelling
  of today's tree, not replayed patches, so intermediate trees need not build.
  Binary blobs, symlinks and gitlinks are copied by object id and mode.
  `HistorySeam`'s second-parent walk then reads epics exactly as today.
- **Notes**: one per synthetic commit under `refs/notes/mythical`; front matter
  `version: 2` (the NOTE FILE FORMAT version — the shipped snapshot note is
  format 1; this is not a product version), plus `sourceHead, sourceTree, seat, actor, confidence`; sections
  Tried / Evidence / Folded / Superseded; trailers `Folded-from:` per real SHA,
  `Change:` when evidenced, `Run:` always. Never invent a Change id.
- **Gate**: `tree(tip) == sourceTree`, every synthetic commit noted, every real
  SHA folded exactly once. Any miss writes nothing.
- **Re-run**: create-only stays, with one exception — refs whose note says
  format `version: 1` (the shipped snapshot) are replaced by CAS in the same
  transaction.
  Foreign or diverged refs refuse.
- **Publish**: push both refs to the repository with the workspace credential
  (`refs/smithers/` is the only reserved namespace, `internal/repohost/refs.go:93`).

## plue changes

- `ListGitRefs` (`internal/services/repo.go:1503`) returns bookmarks only as
  `refs/heads/*`; notes refs are invisible, so `HistorySeam` can never resolve
  the notes commit. Add notes refs to that listing (or a sibling route) and
  serve note blobs by sha.
- **Push credential.** The gateway clones with a temporary token exported into
  git config for the clone command only, and that token is revoked as soon as
  provisioning returns (`internal/services/repo_gateway.go:1357-1375`,
  `internal/services/sandbox_helpers.go:84,160`). The clone URL carries no
  credential, so the flow has nothing to push with. Mint a short-lived
  `write:repository` token for the gateway's own repository on demand — the
  per-run scoped token for agent VMs is the precedent
  (`internal/services/agent_dispatch.go:49`) — rather than parking a long-lived
  credential in the gateway's environment. Until that exists, the history flow writes
  local refs and reports that publication is unavailable; it must not claim a
  published history.

## Agent wiring

Seats `librarian/wiki-author`, `librarian/history-author`, `librarian/reviewer`;
`roleResolver` in `flows/librarian/host.ts` mirroring `flows/coding/host.ts:79-85`,
model from `SMITHERS_LIBRARIAN_MODEL`, `suppliedSeats` accepted for tests.
Per-run `Budget.layer` with `onExceeded: "fail"`. Failures (`SeatUnresolved`,
`BudgetExceeded`, provider outage, verification failure) surface as a failed run
with a reason and the existing Retry door. There is no silent index-only
fallback.

## Tests

Seats resolve to recorded transcripts when `SMITHERS_LIBRARIAN_TRANSCRIPTS` is
set and the API URL is loopback; recording is opt-in. `flows/test/product-host.test.mjs`
keeps its built-artifact/restart coverage but asserts the new shape (core pages,
verified citations, epic merges, notes count, tree equality) and explicitly
strips inherited provider credentials. New unit tests: citation verification
(wrong line, wrong quote, worktree-only file), module selection determinism and
bounds, object graph (renames, deletes, binaries), gate refusals, v1 supersede
CAS, and the failure copy the tutorial shows.
