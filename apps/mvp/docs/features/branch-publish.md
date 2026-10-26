# Publish, Update branch and Resync

A branch `/new` makes is Smithers-only: an ephemeral ref on the repository's Code Storage mirror, edited in its machine's working copy ([decision 0095](../decisions/0095-new-conversation-ephemeral-refs.md)). Nothing reaches GitHub until a person explicitly publishes it. Will, 2026-10-23 14:09 (ruling GH-11): "We avoid interacting with gitthub as much as possible and generrally interacting with github is always explicit. But like everything everything should be a flow and customizable". Publish, Update branch and Resync finish the git loop Will asked for on 2026-10-20 06:39 (ruling GH-6): "finishing the entire git e2e flow of being able to create issues open prs or update branch resync etc."

```
the branch page's Publish ─▶ branch/publish (this device) ─▶ the repository's Publish flow, in the realm
                                ─▶ branches/github-publish { title, body } ─▶ POST /api/repos/<o>/<n>/writes { op: "branch/publish" }
   branch/Publish (Cloudflare) ─▶ the working copy's change against the branch's base, read from its machine as the person
                                ─▶ as the person: the GitHub branch <name>-<key> at the base · one commit · the pull request
                                ─▶ branch_publications row and the write, settled together
Update branch ─▶ branch/update ─▶ the repository's Update flow ─▶ branches/github-update { method } ─▶ writes { op: "branch/update" }
   branch/Update (Cloudflare) ─▶ merge (POST /merges, keyed by the write's trailer) or rebase (fenced by the head read)
                                ─▶ updated · up_to_date · refused conflict
after each Publish and Update done, and Resync ─▶ branch/resync ─▶ writes { op: "branch/resync" } ─▶ branch/Resync
   resync (Cloudflare) ─▶ the Smithers branch on Code Storage to GitHub's head ─▶ the machine's working copy merged onto it
                                ─▶ synced · conflict, its files listed
```

## Publish

- **Explicit.** Only `branch/publish` writes GitHub for a Smithers-only branch: a person's press on the branch page, `/publish <title>`, or the agent once the person approves its call ("Publish this branch to GitHub as a pull request?"). Creating, editing and saving never do.
- **What it publishes.** The working copy's change against the branch's base (the default branch's head when `/new` made it), local commits included, read whole from the branch's machine with the sandbox tools as the person who pressed (`worker/branch/Change.ts`). At most 50 files and 1 MiB of contents; nothing changed is `empty_change`, more is `too_large`.
- **As whom.** A person's Publish and Update retain their session through the compiled `branch/operation/start` and `branch/operation/program` subflows, including every `Flow.to` continuation. A resumed root reads its persisted dispatch door when its tab is gone; retries resolve the same durable lineage. Only this compiled operation chain inherits the session; a run-credential parent retains its credential. Publish verifies that GitHub identifies their stored token as their own user account before any write, then uses that token, so GitHub shows them as the pull request's author and the commit's (ruling GH-2), and applies their permissions. A missing, unreadable, revoked, or wrong-identity token refuses `sign_in_required` (the UI shows “Sign in”); an expiring token waits for the durable session refresh, whose refusal ends the session. No failure substitutes an App token. The agent's goes as the App, its body ending "Smithers for @maya", and each attempt checks again that the person still writes to the repository, as `github/Write` does.
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

## Resync

A published branch's GitHub branch moves on GitHub: Publish's commit, an Update branch's merge or rebase, a push, a commit on github.com. Resync brings the Smithers branch and its working copy to that head, so a file GitHub changed is the working copy's to edit, save and publish again.

- **When.** After every Publish and Update branch that settles `done`, as their flows' last step (`branch/Publish/resync`, `branch/Update/resync`), with the head the write recorded; and when a person or the agent runs `branch/resync` (the branch page's Resync, `/branch.resync`), which reads GitHub's head as the person (as the App for the agent). It writes nothing to GitHub.
- **The Smithers branch.** Its ephemeral ref on Code Storage moves to GitHub's head (`Forge.move`, `CodeStorage.createBranch` with `force`), so the machine's scoped fetch, which serves only that ref's tip ([decision 0095](../decisions/0095-new-conversation-ephemeral-refs.md)), reaches it. A head the mirror hasn't synced from GitHub yet asks the mirror to sync (`Forge.pull`, `CodeStorage.pullUpstream`) and tries again in 5 seconds (`MIRROR_WAIT_MS`).
- **The working copy.** On the branch's machine, as the person, `@smthrs/sandbox`'s `rebaseCall` stages every tracked and untracked change (commits made in the terminal included) and merges it onto GitHub's head with git's own merge base (`merge-tree`), changing nothing: the plan. A change both sides made alike, such as the file a Publish pushed, merges clean. A clean plan applies: HEAD moves to GitHub's head and the working copy's own changes stay on top, uncommitted; commits made in the terminal become working-copy changes. The apply is fenced by the tree the plan saw, so a Save between them plans again.
- **Never drops work.** A file both sides changed stops the resync before anything changes: `conflict`, its files listed on the publication (`sync_conflicts`) for everyone, the working copy as it was. A co-edited file ([co-editing](coedit.md)) whose open text holds typing the working copy hasn't (unsaved) and whose file GitHub changed stops it the same way, listed. Each open text that holds what the working copy held is brought to the file's new contents, keeping its `Saved` mark when it had one; one someone typed in after the plan is left as it is, and listed.
- **Publish again** measures the working copy from the head it was brought to (`synced_sha`), so it sends only what changed since, onto GitHub's head, and a file main changed is the person's to edit and push.
- **Durable.** Every step can run again: the ref moves to one commit, the plan changes nothing, the apply is fenced and a no-op once HEAD is there, and the texts to bring along are recorded (`syncing`) before the working copy changes. Each attempt's machine calls are its own. Nothing retries by hand: an outage fails the step, which its flow tries again (1 s doubling to a minute, for half an hour after a Publish or an Update, an hour for a Resync), then gives up. One Publish or Resync of a branch runs at a time (`409 conflict` at the route).
- **Why not a plugin operation.** Resync writes no GitHub and chooses nothing a repository's flow could: it moves Smithers' own branch and working copy, as the sandbox tools do. Publish and Update branch stay the overridable operations.

## The branch page

Publish, Update branch and Compare live in the branch's chrome ([branch workspace](branch-workspace.md#the-page)), in the fewest words.

```
not published   [Publish]                     ─▶ Title (the branch's name) · Description · [Publish]   Esc closes
                Publishing…  ·  No changes · Too large · Base isn't on GitHub · Conflict · Not allowed · Sign in · Couldn't publish
published       #7   [Publish]   [Update branch]   [Resync]   Code · Terminal · Compare
                     └ Title only (the pull request's, else the branch's name): one more commit
                Updating…  ·  Up to date · Updated · Conflict · Merged · Closed · Not allowed · Sign in · Couldn't update
                Resyncing…  ·  Behind · Conflict · README.md, docs/a.md +2 · Not allowed · Sign in · Couldn't resync
```

- **Who sees what.** Publish, Update branch and Resync show to the branch's owner and editors (`writes(access)`), never on a `locked` branch. The pull request's link `#<n>` (to `/$owner/$repo/pull/$n`) and the Compare tab show to anyone who may view the branch, once its publication row has synced.
- **Publish.** The button opens an inline form: Title, prefilled with the branch's name, and Description; Esc closes it. Its Publish dispatches `branch/publish { repo, branch, title, body }` through `FlowDispatch`, door `button`, as `/publish` and the agent run it. A blank title, or a title or description over GitHub's limits, presses nothing. Once the branch is published, Publish stays: its form asks only for the commit's title, prefilled with the pull request's title once the device has its item, else the branch's name, and sends an empty body.
- **Update branch.** Dispatches `branch/update { repo, branch }`, door `button`.
- **Resync.** Dispatches `branch/resync { repo, branch }`, door `button`. Beside it: `Resyncing…` while the person's Resync runs or is pending; a conflict the last resync listed, whoever's or whichever step's it was, `Conflict · ` and its first three files, then how many more; why the person's last Resync didn't land, until the publication moves on; else `Behind` while GitHub's head is one the working copy hasn't reached (`synced_sha` isn't `head_sha`), and nothing once it has.
- **What the page says.** `Publishing…` or `Updating…` while the press's flow runs, until the write it answered syncs, and while the person's latest write of that operation for the branch is pending (from any of their devices or their agent); the button can't be pressed meanwhile, and a second press on the tab presses nothing. A first Publish that settled `done` stays `Publishing…` until its publication arrives. Then, beside each button, how its latest write ended: a refusal in a word or two, with the button available again; for Update branch, the publication's `update_state` (`Up to date`, `Updated`, `Conflict`, whoever pressed). A press its flow refused says why (`Sign in`, `Not allowed`, else `Couldn't publish` or `Couldn't update`); a Publish refused `exists` met one already on its way, and the writes say where that one is.
- **Compare** (`?compare`). What the published branch's head adds to the base it was published from: its commits (headline, author, short SHA), then each file's diff, as a pull request's Commits and Files tabs show them (the shared `CommitList` and `ChangedFiles`). The page reads `base_sha...head_sha` through `PullsClient.compare` once per pair, and again when the pair changes or after a failed read; a skeleton while it loads, `Couldn't load` when the read failed, `No changes` when they don't differ.

State, by the rules in [state.md](../state.md): the route's `beforeLoad` shows the branch's publication once the branch is open (`publishing.actions.show(branchId, compare)`, `src/features/branch/navigation.ts`), which opens the `branch-publications` shape as an in-memory Electric collection per branch, as sharing opens a branch's shares, and mirrors it into the local `branch-publication`; leaving the page shows none. This tab's presses and Publish's form are the local `branch-publish` row of the branch; Compare's reads are the local `branch-compare`, read by `readComparison` (`src/features/pulls/comparison.ts`), which a pull request's Files tab shares. The person's writes come from the issues' store's `issue-writes` collection, and the pull request's title from its `issue-items`. `publishBarOf` and `compareOf` (`src/features/branch/publishView.ts`) decide every word and what shows; `PublishControls`, `BranchHeader` and `BranchCompare` only render them.

| Piece | File |
|---|---|
| rows, store and queries, actions, the layer (`branch.publishing`) | `publishSchema.ts`, `publishStore.ts`, `publishActions.ts`, `publishing.ts` in `src/features/branch/` |
| the words and what shows | `src/features/branch/publishView.ts` |
| the header's controls, the Compare view | `src/features/branch/components/PublishControls.tsx`, `BranchCompare.tsx` |
| the search param | `?compare` in `src/router.tsx`'s branch search |

Observability: each press is a span and a log line, `branch.publish.press`, `branch.update.press` or `branch.resync.press`, and a count, `smithers_web_branch_publishes`, `smithers_web_branch_updates` or `smithers_web_branch_resyncs`, each by `outcome` (`sent`, the refusal's reason, or `unavailable`); none carries a title, a description or a name. Dispatch adds `flow.dispatch`, and the comparison's read `pulls.compare.get`.

| Test | Proves |
|---|---|
| `src/features/branch/publishView.test.ts` | every state's words and what shows, for an owner, an editor, a viewer, no access and a locked branch; the latest write; Compare's loading, failed, empty and ready |
| `src/features/branch/publish.test.ts` | on a Node device against ChatApi's real writes route, shape and compare route: Publish to pending, a second press refused while it is on its way, the publication's link, Compare and Update branch, the second Publish's form; Update branch to Up to date and Conflict; Resync from Behind to Resyncing…, a conflict's files and nothing once synced, refused beside a Publish on its way; Sign in without a GitHub session; a press while one runs, and one the engine refuses; Compare's commits and files, Couldn't load and its next read; the route's follower and its aborts |

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
| `POST …/writes` `{ writeId, op: "branch/resync", branchId }` | `202` and `branch/Resync` started (`branch-resync:<writeId>`); `409 conflict` while a Publish or another Resync of the branch is on its way (a Publish waits for a Resync too); refusals as Publish's |
| `GET /api/branches/creation?owner=<o>&name=<n>&operation=publish\|update` | the operation's selected flow ([branch creation](branch-creation.md)) |
| `GET /api/shapes/branch-publications?branch=<id>` | the branch's publication, to anyone who may view the branch; anyone else a shape with no rows |
| `GET /api/repos/<owner>/<name>/compare/<base>...<head>` | the files and commits two commits differ by, on any repository the person may read ([pull requests](pulls.md#routes)) |

## Postgres

Migrations `0068_branch_publish` and `0069_branch_resync`.

| | |
|---|---|
| `github_writes` | takes `branch/publish`, `branch/update` and `branch/resync` with their refusals; `branch_id` names the branch they act on (the person's devices read it with the write's status); at most one Publish and one Resync of a branch pending |
| `branch_publications` | one row per published branch: `github_ref`, `base_ref`, `base_sha`, `head_sha`, `pr_number`, `write_id`, `update_state`, `synced_sha`, `sync_state` (`synced`, `conflict`), `sync_conflicts` (the files), `updated_at`; `pushed`, `pushed_sha`, `pushing_write` and `pushing_from` for the pushes (relative to `synced_sha` once a resync ran), and `syncing` (the texts a resync on its way brings along), never synced; written only by `branch/Publish`, `branch/Update` and resync |

## Observability

| Record | Kind | Fields |
|---|---|---|
| `branch.publish`, `branch.update` | log, span | `writeId`, `outcome` (`done`, `updated`, `up_to_date`, or the refusal), `settled`, `method`, `projection` (`failed`), `errorCode` |
| `smithers_branch_publishes{outcome}`, `smithers_branch_updates{outcome,method}` | counters | |
| `branch.change.collect` | span | the working copy read |
| `branch.resync` | log, span | `writeId`, `outcome` (`synced`, `conflict`, `unavailable`, `invalid`, `too_large`, `mirror_pull_failed`), `files` (a conflict's count), `errorCode`; `branch.resync.send` and `branch.resync.after` spans for the steps |
| `smithers_branch_resyncs{outcome}` | counter | |
| `smithers_branch_publication_shape_requests{status,live}`, `branch.publications.shape` | counter, log | |
| `branch.operation.evaluate`, `branch.operation.call`; `smithers_branch_operation_steps{operation,outcome}` | browser spans, logs, counter | the realm round and the host call |

No record carries a title, a body, a path, a branch name or a login. The machine's own records (`sandbox.object.tool`, `smithers_sandbox_checkpoints`) and Code Storage's (`code_storage_requests{operation="createBranch"|"pullUpstream"}`) count resync's calls too.

## Tests

| Test | Proves |
|---|---|
| `worker/branch/Resync.test.ts` | resync against real git (GitHub, Code Storage and the machine's checkout as local repositories, the machine's tools running their real scripts) and Postgres: after Update branch the Smithers branch and working copy reach GitHub's head with the working copy's own changes and terminal commits kept; a file both changed is a conflict listing it with nothing changed; unrelated history; co-edited texts: a saved one follows the file and stays Saved, an unsaved one GitHub changed stops it, an empty one opened before the file arrived takes it, one for a deleted file empties; the mirror behind GitHub asked to sync; a Save between plan and apply; a step run again after the apply, and typing since; refusals and outages of the forge, the machine and Postgres; `branch/Resync` as the person, its conflict, a deleted GitHub branch, not published, give-up; the step after a Publish or an Update; Publish again after a resync sends only what changed onto GitHub's head |
| `worker/branch/Publish.test.ts` | Publish as the person and as the App; empty, too large, a missing base, a refused pull request; a lost answer to the branch, the commit or the pull request found by its key; publishing again: only what changed, reverted files put back, a file GitHub changed refused `conflict`, a lost answer and a step run again on its recorded head, a merged, closed or deleted target; the agent for someone who no longer writes; tokens and GitHub retried; Update by merge and rebase, up to date, conflict, a lost answer, a moved head, merged and closed, not published; give-up; the remote host through `withBranchPublish` |
| `worker/branch/PublishApi.test.ts` | the writes route's admission and refusals, one Publish at a time, one Resync at a time and never beside a Publish, the publication shape's access |
| `worker/branch/Change.test.ts`, `Creation.test.ts` | the working copy's read and its refusals; the selection per operation and a repository's override |
| `src/features/branch/publishSteps.test.ts` | the first-party flows in the real realm, the host call over a real socket, `branch/publish`, `branch/update` and `branch/resync` on the engine |
| `worker/branch/Forge.test.ts` | `Forge.move` with force and `Forge.pull` over Code Storage, a sync already running, their refusals; GitHub's forge refuses both |
| `packages/smithers/flows/sandbox/test/SandboxTools.test.ts` (`SandboxTools rebase`) | the plan and the apply on real git: local commits and a new file kept, a conflict listed with nothing changed, a stale plan applying nothing, an origin without the commit or unreachable, unrelated history, no repository |
| `packages/effect-code-storage/test/CodeStorage.test.ts` | `createBranch` with `force` moves a branch that exists, back or forth |
| `packages/smithers/agent/integrations/test/{Once,Pulls}.test.ts` | `GitHub.Once.mergeInto`, `GitHub.Pulls.updateBranch`, a comparison's commits |
| `e2e/branch-publish.spec.ts` | `/new`, edit and save a file, Publish, the pull request on GitHub as the test account holding the file, Update branch after main moved, the working copy following it (no longer Behind), the file main added edited and saved, Publish again holding main's line and the edit, Compare: against a deployment with the GitHub App, on the scratch repository (`requires("githubScratch", "member", "githubAppKey")`), cleaning up its pull request and branch |

## Libraries

"Touch GitHub" (`@smthrs/integrations`: `GitHub.Once`, `GitHub.Pulls`, `GitHub.Commits`, `GitHub.Refs`), `@smthrs/flow` (`Action.once`), `@smthrs/harness` (`RealmFlow`), `@smthrs/plugin` (`Manifest`, `Load`), `@smthrs/sandbox` (`SandboxTools` on the branch's machine, `SandboxTools.rebaseCall` for resync), `@smthrs/effect-code-storage` (`createBranch` with `force`, `pullUpstream`), "Edit one text together" (`@smthrs/sync`'s `SharedText`, for the texts resync brings along), `@smthrs/effect-electric` (`ShapeProxy`).

## Not built yet

- Resync on its own when GitHub's branch moves without Smithers (a push, a commit on github.com): the page says `Behind` only once the publication learns the head; until then the person presses Resync.
- A faster resync fetch: the scoped proxy drops the machine's haves, so each fetch carries the branch's whole history again, as a clone does.
- A compare view before Publish: the working copy's diff shows in the editor, not on the Compare tab.
- The branches page.

Publish and Update attempts log `branch.write.identity` and count `smithers_branch_write_identities` by `op` and `identity` (`person` or `app`), without login or token. The browser also logs `branch.write.identity` at credential resolution with `runId`, `parentRunId`, `flow`, credential kind and identity, so the continuation where authority changed is visible through the telemetry relay.
