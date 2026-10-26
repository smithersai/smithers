# Publish and Update branch

A branch `/new` makes is Smithers-only: an ephemeral ref on the repository's Code Storage mirror, edited in its machine's working copy ([decision 0095](../decisions/0095-new-conversation-ephemeral-refs.md)). Nothing reaches GitHub until a person explicitly publishes it. Will, 2026-10-23 14:09 (ruling GH-11): "We avoid interacting with gitthub as much as possible and generrally interacting with github is always explicit. But like everything everything should be a flow and customizable". Publish and Update branch finish the git loop Will asked for on 2026-10-20 06:39 (ruling GH-6): "finishing the entire git e2e flow of being able to create issues open prs or update branch resync etc."

```
the branch page's Publish ─▶ branch/publish (this device) ─▶ the repository's Publish flow, in the realm
                                ─▶ branches/github-publish { title, body } ─▶ POST /api/repos/<o>/<n>/writes { op: "branch/publish" }
   branch/Publish (Cloudflare) ─▶ the working copy's change against the branch's base, read from its machine as the person
                                ─▶ as the person: the GitHub branch <name>-<key> at the base · one commit · the pull request
                                ─▶ branch_publications row and the write, settled together
Update branch ─▶ branch/update ─▶ the repository's Update flow ─▶ branches/github-update { method } ─▶ writes { op: "branch/update" }
   branch/Update (Cloudflare) ─▶ merge (POST /merges, keyed by the write's trailer) or rebase (fenced by the head read)
                                ─▶ updated · up_to_date · refused conflict
```

## Publish

- **Explicit.** Only `branch/publish` writes GitHub for a Smithers-only branch: a person's press on the branch page, `/publish <title>`, or the agent once the person approves its call ("Publish this branch to GitHub as a pull request?"). Creating, editing and saving never do.
- **What it publishes.** The working copy's change against the branch's base (the default branch's head when `/new` made it), local commits included, read whole from the branch's machine with the sandbox tools as the person who pressed (`worker/branch/Change.ts`). At most 50 files and 1 MiB of contents; nothing changed is `empty_change`, more is `too_large`.
- **As whom.** A person's Publish uses their own GitHub token, so GitHub shows them as the pull request's author and the commit's (ruling GH-2), and applies their permissions. The agent's goes as the App, its body ending "Smithers for @maya", and each attempt checks again that the person still writes to the repository, as `github/Write` does.
- **What it makes.** A GitHub branch named after the Smithers branch with the write's key, `<name>-<12 hex>`, at the base; one commit (`createCommitOnBranch`, fenced by the base) titled with the pull request's title; the pull request into the repository's default branch with the person's title and description. A base GitHub doesn't have (a mirror behind GitHub) is `base_missing`, and nothing is made.
- **Once.** Each GitHub write goes through `Action.once` with a key derived from the write id the route recorded (`keyOf`): the branch's name suffix, the commit's `Smithers-Write` trailer, the pull request's hidden marker. A step that runs again after a lost answer finds each by its key, never by a name or a title (ruling DUR-8). One Publish of a branch may be on its way at a time: the route refuses a second with `409 conflict`, and Postgres holds it (`github_writes_branch_publish`).
- **Linked.** The settled write and the `branch_publications` row commit together: the GitHub branch, the base, the head, the pull request's number. Everyone who may view the branch syncs the row; the branch page links its pull request, and its conversation is the branch's.

## Publish again

Editing goes on after the first Publish; each later Publish pushes what changed since the last push as one more commit on the same GitHub branch and pull request, titled with the title the person gave.

- **Only what changed.** The publication keeps what the pushes wrote, by path (`pushed`: the contents' SHA-256, or null for a deletion). A push sends each file whose working-copy contents differ from the last push's, and puts back as the base has it each file the working copy no longer changes (a reverted file, a removed new one). Nothing different is `empty_change`.
- **Never overwrites GitHub.** A file GitHub changed since the last push (an Update branch's merge, a commit on github.com) that the push also changes is refused `conflict`; one it doesn't change stays as GitHub has it, and the push lands on top. A merged or closed pull request is refused `merged` or `closed`, a GitHub branch someone deleted `not_found`.
- **Once.** The head the push commits onto is recorded on the publication before the commit (`pushing_from`), so a step that runs again fences on that head and finds its commit by the trailer.

## Update branch

- **What it does.** Takes the pull request's base into its branch on GitHub, as the person (or as the App for the agent, rechecked as Publish is). The repository's Update flow chooses the method; the first-party one merges, as GitHub's Update branch button does.
- **Merge.** `POST /merges` with the base as head, through `GitHub.Once.mergeInto`: its merge commit carries the write's trailer, so a lost answer is found by it. GitHub's `204` is `up_to_date`, `201` `updated`, `409` refused `conflict`.
- **Rebase.** GraphQL `updatePullRequestBranch` with `updateMethod: REBASE`, fenced by the head the step read (`expectedHeadOid`). A rebase writes no marker: a step that runs again reads the pull request, and a head that moved and holds the base is the rebase's. A refusal with the head unchanged is `conflict` when GitHub says the branch conflicts (`mergeable_state: dirty`), else `not_mergeable`; a moved head is `head_moved`.
- **Truthful.** A conflict is reported on the branch for everyone (`update_state = 'conflict'`) and never resolved in the background. A merged or closed pull request is refused `merged` or `closed`; a branch not yet published `not_published`.

## The branch page

Publish, Update branch and Compare live in the branch's chrome ([branch workspace](branch-workspace.md#the-page)), in the fewest words.

```
not published   [Publish]                     ─▶ Title (the branch's name) · Description · [Publish]   Esc closes
                Publishing…  ·  No changes · Too large · Base isn't on GitHub · Conflict · Not allowed · Sign in · Couldn't publish
published       #7   [Publish]   [Update branch]   Code · Terminal · Compare
                     └ Title only (the pull request's, else the branch's name): one more commit
                Updating…  ·  Up to date · Updated · Conflict · Merged · Closed · Not allowed · Sign in · Couldn't update
```

- **Who sees what.** Publish and Update branch show to the branch's owner and editors (`writes(access)`), never on a `locked` branch. The pull request's link `#<n>` (to `/$owner/$repo/pull/$n`) and the Compare tab show to anyone who may view the branch, once its publication row has synced.
- **Publish.** The button opens an inline form: Title, prefilled with the branch's name, and Description; Esc closes it. Its Publish dispatches `branch/publish { repo, branch, title, body }` through `FlowDispatch`, door `button`, as `/publish` and the agent run it. A blank title, or a title or description over GitHub's limits, presses nothing. Once the branch is published, Publish stays: its form asks only for the commit's title, prefilled with the pull request's title once the device has its item, else the branch's name, and sends an empty body.
- **Update branch.** Dispatches `branch/update { repo, branch }`, door `button`.
- **What the page says.** `Publishing…` or `Updating…` while the press's flow runs, until the write it answered syncs, and while the person's latest write of that operation for the branch is pending (from any of their devices or their agent); the button can't be pressed meanwhile, and a second press on the tab presses nothing. A first Publish that settled `done` stays `Publishing…` until its publication arrives. Then, beside each button, how its latest write ended: a refusal in a word or two, with the button available again; for Update branch, the publication's `update_state` (`Up to date`, `Updated`, `Conflict`, whoever pressed). A press its flow refused says why (`Sign in`, `Not allowed`, else `Couldn't publish` or `Couldn't update`); a Publish refused `exists` met one already on its way, and the writes say where that one is.
- **Compare** (`?compare`). What the published branch's head adds to the base it was published from: its commits (headline, author, short SHA), then each file's diff, as a pull request's Commits and Files tabs show them (the shared `CommitList` and `ChangedFiles`). The page reads `base_sha...head_sha` through `PullsClient.compare` once per pair, and again when the pair changes or after a failed read; a skeleton while it loads, `Couldn't load` when the read failed, `No changes` when they don't differ.

State, by the rules in [state.md](../state.md): the route's `beforeLoad` shows the branch's publication once the branch is open (`publishing.actions.show(branchId, compare)`, `src/features/branch/navigation.ts`), which opens the `branch-publications` shape as an in-memory Electric collection per branch, as sharing opens a branch's shares, and mirrors it into the local `branch-publication`; leaving the page shows none. This tab's presses and Publish's form are the local `branch-publish` row of the branch; Compare's reads are the local `branch-compare`, read by `readComparison` (`src/features/pulls/comparison.ts`), which a pull request's Files tab shares. The person's writes come from the issues' store's `issue-writes` collection, and the pull request's title from its `issue-items`. `publishBarOf` and `compareOf` (`src/features/branch/publishView.ts`) decide every word and what shows; `PublishControls`, `BranchHeader` and `BranchCompare` only render them.

| Piece | File |
|---|---|
| rows, store and queries, actions, the layer (`branch.publishing`) | `publishSchema.ts`, `publishStore.ts`, `publishActions.ts`, `publishing.ts` in `src/features/branch/` |
| the words and what shows | `src/features/branch/publishView.ts` |
| the header's controls, the Compare view | `src/features/branch/components/PublishControls.tsx`, `BranchCompare.tsx` |
| the search param | `?compare` in `src/router.tsx`'s branch search |

Observability: each press is a span and a log line, `branch.publish.press` or `branch.update.press`, and a count, `smithers_web_branch_publishes` or `smithers_web_branch_updates`, each by `outcome` (`sent`, the refusal's reason, or `unavailable`); none carries a title, a description or a name. Dispatch adds `flow.dispatch`, and the comparison's read `pulls.compare.get`.

| Test | Proves |
|---|---|
| `src/features/branch/publishView.test.ts` | every state's words and what shows, for an owner, an editor, a viewer, no access and a locked branch; the latest write; Compare's loading, failed, empty and ready |
| `src/features/branch/publish.test.ts` | on a Node device against ChatApi's real writes route, shape and compare route: Publish to pending, a second press refused while it is on its way, the publication's link, Compare and Update branch, the second Publish's form; Update branch to Up to date and Conflict; Sign in without a GitHub session; a press while one runs, and one the engine refuses; Compare's commits and files, Couldn't load and its next read; the route's follower and its aborts |

## Overriding the flows

Publish and Update branch are flows of the first-party `branches` plugin (`plugins/branches/src/publish.ts`, `update.ts`), selected and run exactly as [branch creation](branch-creation.md) runs its flow: the selection is journaled with its source, commit and digest, the source runs in `@smthrs/harness`'s `RealmFlow`, and each host action is a durable receipt. A repository replaces either in `.smithers/branch.json`, naming a flow its plugin owns for each operation it replaces; an operation it names none for runs the first-party flow:

```json
{ "plugin": "team-branches", "flow": "create", "publish": "ship", "update": "sync" }
```

`.smithers/flows/team-branches/sync/flow.ts` that rebases instead of merging:

```ts
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

const Update = Action.make("branches/github-update", {
  payload: { method: Schema.Literals(["merge", "rebase"]) },
  success: Schema.Unknown,
})

export default Flow.make("team-branches/sync", {
  description: "Rebase a published branch onto its base.",
  capabilities: ["github:write"],
  payload: {},
  success: Schema.Unknown,
  body: Node.capture({ update: Update.name }, () => Update.call({ method: "rebase" })),
})
```

The manifest owns `sync` and uses `branches/github-update` with `github:write`. A Publish flow calls `branches/github-publish { title, body }` and may change both. Each flow may call only its own operation's action (`OPERATION_ACTIONS`); the host fixes the branch, the write's id and the session, and the server re-checks everything the route checks. A malformed installation refuses the operation; it never falls back to the first-party flow.

## Routes

| Route | Answers |
|---|---|
| `POST /api/repos/<owner>/<name>/writes` `{ writeId, op: "branch/publish", branchId, title, body }` | `202 { txid, writeId }` and `branch/Publish` started (`branch-publish:<writeId>`), the first Publish or the next push; `200` for a resend; `403 forbidden` for someone who can't edit the branch or a Guest; `404 not_found` for a branch of another repository; `409 conflict` while another Publish of the branch is on its way; `401`, `400` as other writes |
| `POST …/writes` `{ writeId, op: "branch/update", branchId, method? }` | `202` and `branch/Update` started (`branch-update:<writeId>`); `merge` unless `method` says `rebase` |
| `GET /api/branches/creation?owner=<o>&name=<n>&operation=publish\|update` | the operation's selected flow ([branch creation](branch-creation.md)) |
| `GET /api/shapes/branch-publications?branch=<id>` | the branch's publication, to anyone who may view the branch; anyone else a shape with no rows |
| `GET /api/repos/<owner>/<name>/compare/<base>...<head>` | the files and commits two commits differ by, on any repository the person may read ([pull requests](pulls.md#routes)) |

## Postgres

Migration `0068_branch_publish`.

| | |
|---|---|
| `github_writes` | takes `branch/publish` and `branch/update` with their refusals; `branch_id` names the branch they act on (the person's devices read it with the write's status); at most one Publish of a branch pending |
| `branch_publications` | one row per published branch: `github_ref`, `base_ref`, `base_sha`, `head_sha`, `pr_number`, `write_id`, `update_state`, `updated_at`; `pushed`, `pushed_sha`, `pushing_write` and `pushing_from` for the pushes, never synced; written only by `branch/Publish` and `branch/Update` |

## Observability

| Record | Kind | Fields |
|---|---|---|
| `branch.publish`, `branch.update` | log, span | `writeId`, `outcome` (`done`, `updated`, `up_to_date`, or the refusal), `settled`, `method`, `projection` (`failed`), `errorCode` |
| `smithers_branch_publishes{outcome}`, `smithers_branch_updates{outcome,method}` | counters | |
| `branch.change.collect` | span | the working copy read |
| `smithers_branch_publication_shape_requests{status,live}`, `branch.publications.shape` | counter, log | |
| `branch.operation.evaluate`, `branch.operation.call`; `smithers_branch_operation_steps{operation,outcome}` | browser spans, logs, counter | the realm round and the host call |

No record carries a title, a body, a path, a branch name or a login.

## Tests

| Test | Proves |
|---|---|
| `worker/branch/Publish.test.ts` | Publish as the person and as the App; empty, too large, a missing base, a refused pull request; a lost answer to the branch, the commit or the pull request found by its key; publishing again: only what changed, reverted files put back, a file GitHub changed refused `conflict`, a lost answer and a step run again on its recorded head, a merged, closed or deleted target; the agent for someone who no longer writes; tokens and GitHub retried; Update by merge and rebase, up to date, conflict, a lost answer, a moved head, merged and closed, not published; give-up; the remote host through `withBranchPublish` |
| `worker/branch/PublishApi.test.ts` | the writes route's admission and refusals, one Publish at a time, the publication shape's access |
| `worker/branch/Change.test.ts`, `Creation.test.ts` | the working copy's read and its refusals; the selection per operation and a repository's override |
| `src/features/branch/publishSteps.test.ts` | the first-party flows in the real realm, the host call over a real socket, `branch/publish` and `branch/update` on the engine |
| `packages/smithers/agent/integrations/test/{Once,Pulls}.test.ts` | `GitHub.Once.mergeInto`, `GitHub.Pulls.updateBranch`, a comparison's commits |
| `e2e/branch-publish.spec.ts` | `/new`, edit and save a file, Publish, the pull request on GitHub as the test account holding the file, Update branch after main moved, Compare: against a deployment with the GitHub App, on the scratch repository (`requires("githubScratch", "member", "githubAppKey")`), cleaning up its pull request and branch |

## Libraries

"Touch GitHub" (`@smthrs/integrations`: `GitHub.Once`, `GitHub.Pulls`, `GitHub.Commits`, `GitHub.Refs`), `@smthrs/flow` (`Action.once`), `@smthrs/harness` (`RealmFlow`), `@smthrs/plugin` (`Manifest`, `Load`), `@smthrs/sandbox` (`SandboxTools` on the branch's machine), `@smthrs/effect-electric` (`ShapeProxy`).

## Not built yet

- The working copy following the GitHub branch (resync): after an Update branch or a commit on github.com, a file changed there is refused `conflict` on the next push rather than merged into the working copy.
- A compare view before Publish: the working copy's diff shows in the editor, not on the Compare tab.
- The branches page.
