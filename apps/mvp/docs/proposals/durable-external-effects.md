# Durable external effects: one identity per write, found before it is written again

Status: built (2026-10-21 to 10-23): `Action.once` in `@smthrs/flow`, `GitHub.Once` in `@smthrs/integrations`, the TODO run's branch, commit and pull request, the app's GitHub writes, triage and merges, and the lint rule `durable.external-writes-once`. Will asked (10:40): "for that bug you found you should have the agent think hard about durability what is the clean way to use smithers to make issues like that not an issue". Claude Opus and Codex Sol designed independently from one brief (PROC-6); Opus merged the two below and decided each disagreement with the evidence cited. Every `file:line` is at `main@origin` e93c4812 unless it says otherwise.

Prefixes: `F/` = `packages/smithers/flows/`, `A/` = `packages/smithers/agent/`, `N/` = `packages/smithers/notifications/`, `M/` = `apps/mvp/`.

## 1. Summary

**In one sentence.** Every external write in a durable step goes through `Action.once(name, adapter)`, which derives the write's identity from the execution and the engine's dispatch key (never from content), has the adapter stamp it on the object in the same request that creates it, and looks the object up by that identity before writing on every run of the step; a write that can carry no identity runs alone in an `irreversible` step, which the durable engine already runs at most once.

**The class.** A step dispatched under key K makes a write W. The journal records the step's outcome only after W answers. A lost answer, a crash or a takeover inside that window leaves no record, so the engine runs the step again: attempt n+1, or the same attempt with `Action.CurrentRedispatch`. The step must then answer "did W happen, and which object is it?". Today each site answers from what the object looks like: the TODO commit by its parent and its message `T<n>: <title>` + `Smithers for @<login>` (`M/worker/flows/Todo.ts:526-529`), the TODO branch by its name and the base sha (`Todo.ts:438-447`), a triage comment within "now minus 91 minutes" (`M/worker/github/Triage.ts:619-622`). Each answer can adopt someone else's object or miss its own.

**What the engine already has.** The identity exists. `Action.CurrentInvocationKey` (`F/flow/src/Action/Context.ts:125`) is provided to every dispatch (`F/engine/src/FlowEngine/Dispatch.ts:342`), stable across its attempts and redispatches and distinct between dispatches. For `irreversible` actions the durable engine commits an `intended` crossing before the body and a `succeeded` crossing with the outcome after it (`F/engine-store/src/internal/ActionPersistence.ts:2420-2540`); a recovered attempt with a `succeeded` crossing settles without running the body (`:2109`), and one left `intended` re-runs only when the action declares an `idempotencyKey`, otherwise it fails `IrreversibleRetryRequiresIdempotencyKey` (`:2142`). That is at-most-once for writes nobody can look up. What is missing is the last step: nothing hands the identity to the write, and nothing makes the step look the write up by it.

**The primitive.** `Action.once(name, { find, perform })` in `@smthrs/flow`, about 60 lines. The key is `sha256("smithers/effect/v1", executionId, invocationKey, name)`, 64 hex. `once` calls `find(key)`; if it answers the object, that is the result; if it answers none, `perform(key)`; if `perform` fails (a lost answer, a conflict), `find` again before giving up. Adapters live with each provider: `GitHub.Once.branch`, `commitOnBranch`, `pull`, `issue`, `comment`, `review` in `@smthrs/integrations`. App code calls `Action.once("commit", GitHub.Once.commitOnBranch(...))` and writes no recovery.

**The guarantees, stated per effect.**

| Effect kind | Identity on the object | Guarantee |
|---|---|---|
| Fenced create (commit with `expectedHeadOid`, ref create, a PR for one head) | trailer `Smithers-Write: <key>`, branch-name suffix, PR body marker | exactly once: the provider refuses a second write, `once` finds the first |
| Marked create without a fence (issue, comment, review) | body marker `<!-- smithers:write=<key> -->` | once, except when the first request is still in flight at GitHub when the lookup runs; then two can exist and the earliest is adopted (at least once in that window) |
| Provider idempotency key (Resend email) | `Idempotency-Key: <key>` | once within the provider's window (24 h for Resend) |
| No identity channel (Telegram, a merge, a refresh-token redemption) | none | the step's declaration chooses: at most once (`irreversible`, no `idempotencyKey`: an unsettled crossing stops typed), or at least once (`idempotencyKey` declared: the engine repeats it) |

**What it costs.** One lookup read per write, on the happy path too. Always looking first keeps `once` correct on a host that lost its journal or never reports `CurrentRedispatch`.

**Confidence: 82%** that this is the right default. It would rise with a live GitHub run of the TODO crash matrix (the scripted GitHub is the evidence today) and with a proof that GitHub's comment lists are read-after-write consistent. Riskiest assumption: a step's dispatch key is stable across deploys. Renaming an action or changing its schemas or tier re-keys the step and its writes, exactly as it already loses the step's recorded result; a fenced write then refuses (no duplicate) and a marked write can repeat once.

## 2. Inventory

28 sites. "Bad" means the step adopts or refuses by content, name, time, state or "latest"; "none" means it has no recovery at all. Two Explore sweeps and Sol's sweep agreed on every bad site below; each was read again for this table.

| # | file:line | Effect | How it recovers today | What goes wrong | Verdict |
|---|---|---|---|---|---|
| 1 | `M/worker/flows/Todo.ts:526-529` | GitHub commit (`createCommitOnBranch`) | head's parent is the base and its message is `T<n>: <title>\n\nSmithers for @<login>` | another attempt's or a person's commit with the same number, title and login is adopted and published as this attempt's change | bad: content |
| 2 | `M/worker/flows/Todo.ts:438-447` | GitHub branch create | a branch named `smithers/t<n>-<slug>` at the base sha is ours | another attempt's, deployment's or person's branch at the base is adopted; two runs can publish to one branch | bad: name + state |
| 3 | `M/worker/flows/Todo.ts:434-449` | the same | the base is re-read from the default branch on every retry | a retry after the default branch moved makes `...-2` and leaks the first branch; five leaks end `publish_refused` | bad: latest |
| 4 | `M/worker/flows/Todo.ts:433` | the same | `todos.branch`/`base_sha` are per TODO, not per attempt | a second attempt reuses the first attempt's branch | bad: wrong scope (latent) |
| 5 | `M/worker/flows/Todo.ts:548-559` | starts `ChecksRun` | execution id from the head sha | two attempts at one head share one checks run | content (sha), low |
| 6 | `M/worker/github/Triage.ts:619-622` | rejection comment | marker = decision id, searched `since: now - 91 min` | a resume after 91 minutes misses its own comment and posts a second | bad: time window |
| 7 | `M/worker/github/Triage.ts:366-371` | needs-repro comment | marker = v5(repo#number), since the issue's creation | correct domain key (one per issue); finder ignores truncation | bounded search |
| 8 | `M/worker/github/Write.ts:207-230` | issue create, comment | marker = write id, `since: createdAt - slack`, app attempt counter `Store.beginAttempt` | identity right; truncation reads as absence; the app counts attempts the engine already counts | bounded search, hand-rolled |
| 9 | `M/worker/flows/Checks.ts:243-257` | PR review | marker = check run id | finder ignores truncation | bounded search |
| 10 | `M/worker/github/Merge.ts:126-131` | merge | an earlier attempt + PR merged at this head = our merge | a person's merge at that head is recorded as this write's | bad: state |
| 11 | `M/worker/branch/Branches.ts:81-100` | Code Storage branch create | 409 `exists` → track that branch | a branch someone else made with that name becomes the requester's new branch | bad: name |
| 12 | `M/worker/PersonalFlows.ts:282-295` | flow revision | adopts revision n+1 when its digest matches | same bytes from another device are adopted; only `created_by` is wrong | content, harmless |
| 13 | `M/worker/flows/SpendAlert.ts:361-396` | email + Telegram send | `alert_deliveries` row written after the send | a crash after the send and before the row sends again; Telegram has no key | none |
| 14 | `M/src/features/flows-ui/steps.ts:58` | draft write | `crypto.randomUUID()` per round | a retried round writes a second draft | none |
| 15 | `A/integrations/src/github/Commits.ts:15-18` | `createOnBranch` docs | "adopt its head when ... its message carries the step's marker"; no marker helper exists | the doc rule nobody can follow led to #1 | bad doc |
| 16 | `A/integrations/src/github/Refs.ts:114-116` | `createBranch` docs | "adopt it when it points at `sha`" | the doc rule behind #2 | bad doc |
| 17 | `A/integrations/src/github/Issues.ts:472-491` | `findIssueByWrite` | caller's id, `since`, 10 pages | `truncated` ignored: a long list reads as absence and the write repeats | bounded search |
| 18 | `A/integrations/src/github/Issues.ts:504-521` | `findCommentByWrite` | same | same | bounded search |
| 19 | `A/integrations/src/github/Pulls.ts:280-291` | `findPullByHead` | `writeId` optional | without one, any PR ever opened from that branch name is adopted | bad when unkeyed |
| 20 | `A/integrations/src/github/Pulls.ts:489-499` | `findReviewByWrite` | caller's id, 10 pages | truncation reads as absence | bounded search |
| 21 | `A/integrations/src/github/Pulls.ts:370` | `mergePull` docs | read the PR back for `merged` | the rule behind #10 | state |
| 22 | `A/integrations/src/github/Actions.ts:324-404` | `UpsertComment` | caller's sticky key + author; fails on truncation | key per run, not per step: two steps sharing it overwrite one comment | caller key |
| 23 | `A/integrations/src/github/Actions.ts:473-551` | `CheckRun` | caller's `external_id` | same | caller key |
| 24 | `A/integrations/src/github/Actions.ts:595-675` | `LinkPullRequest` | regex over the body, then PATCH the whole body | a quoted "fixes #N" counts as linked; a person's edit in between is overwritten | content, read-modify-write |
| 25 | `A/integrations/src/core/IssueSync.ts:160` | reconcile delivery | `crypto.randomUUID()` per run | never replayable | none |
| 26 | `N/src/Channels.ts:399-409` | Telegram `sendMessage` | none (documented at `:18-20`) | a crash after Telegram answers sends twice | none |
| 27 | `F/sandbox/src/SandboxMerge/apply.ts:151` | jj change landed on the host | `options.key ?? session + base + patch` | without a key, two steps with one patch collapse and a changed patch lands twice | content default |
| 28 | `packages/smithers/src/internal/backend/Stack.ts:94-108, 264` | CLI push + stacked PR | PR found by change id in state saved after the loop | a crash after the POST re-POSTs and fails 422 | none |

Already right, and reused: the PR marker keyed by the attempt (`Todo.ts:532-541`), `Write.ts`'s marker anchored to the write's admission time, `UpsertComment`'s author check and truncation refusal (`A/integrations/src/github/Actions.ts:364-382`), Resend's `Idempotency-Key` (`N/src/Channels.ts:382`), `ExternalJob`'s create-or-get by a key from the execution (`F/flow/src/ExternalJob.ts:92, 151`), named containers (`F/platform-cloudflare/src/SandboxObject.ts:130`), execution-keyed remote starts, and `EngineChildren`'s steer message keyed by the dispatch (`A/src/EngineChildren.ts:518-558`). Model calls stay at least once on a mid-flight crash, as documented (`A/src/internal/ModelStep.ts:910-931`).

## 3. How Temporal, Restate, DBOS and AWS do it

| System | What it promises | What it tells you to do about outside writes |
|---|---|---|
| Temporal | An activity "may be executed multiple times"; its completion is "observed ... exactly once" | "use a combination of the Workflow Run ID and the Activity ID as an idempotency key ... consistent across retry attempts but unique among Workflow Executions" ([activity definition](https://docs.temporal.io/activity-definition)) |
| Restate | `ctx.run` journals a result; a failed run retries | `ctx.rand.uuidv4()` is "seeded by the invocation ID" and returns the same value on retries, "to generate stable UUIDs for things like idempotency keys" ([journaling results](https://docs.restate.dev/develop/ts/journaling-results)) |
| DBOS | "Steps are tried at least once but are never re-executed after they complete"; a workflow ID is the workflow's idempotency key | steps must be idempotent; `DBOS.workflowID` and the step id are the identity material ([workflow tutorial](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial)) |
| AWS Lambda durable functions | at least once per retry by default; at most once per retry waits for the START checkpoint and raises `StepInterrupted` on replay | "generate a key inside a step once and pass it to every attempt of the side-effecting step"; at most once "is for ... a one-shot SMS or a POST to a non-idempotent API" ([idempotency](https://docs.aws.amazon.com/durable-execution/patterns/best-practices/idempotency/)) |

Smithers maps onto all four: the dispatch key is Temporal's run id plus activity id and Restate's invocation-seeded value; the `intended` crossing is AWS's START checkpoint; a keyless `irreversible` action is AWS's at-most-once mode. None of them helps with a provider that takes no idempotency key and offers only lookup, which is GitHub for everything but labels. The adapter's marker-and-find contract is the part Smithers adds.

## 4. The primitive

### 4.1 `@smthrs/flow`, module `Action`

```ts
/** A write that carries its key and can be found by it. */
export interface Keyed<A, E = never, R = never> {
  /** The object `key` made, `None` only after a complete search; fails when it can't tell. */
  readonly find: (key: string) => Effect.Effect<Option.Option<A>, E, R>
  /** Makes the object, carrying `key` in the same request. */
  readonly perform: (key: string) => Effect.Effect<A, E, R>
}

/** Infers a `Keyed`'s types. */
export const keyed: <A, E = never, R = never>(effect: Keyed<A, E, R>) => Keyed<A, E, R>

/**
 * The key of write `name` in the running dispatch: 64 lowercase hex of
 * sha256("smithers/effect/v1\n" + executionId + "\n" + invocationKey + "\n" + name).
 * Dies with `EffectKeyUnavailable` outside a dispatch.
 */
export const effectKey: (name: string) => Effect.Effect<string>

/** Finds write `name`'s object, or makes it once. */
export const once: <A, E, R>(name: string, effect: Keyed<A, E, R>) => Effect.Effect<A, E, R>

/** A defect: `once` or `effectKey` ran where no dispatch identity is supplied. */
export class EffectKeyUnavailable extends Schema.TaggedError<EffectKeyUnavailable>()(
  "@smthrs/flow/EffectKeyUnavailable",
  { name: Schema.String, message: Schema.String },
) {}
```

- **Identity from the execution and the step only.** `executionId` comes from `FlowRuntime.FlowInstance`, `invocationKey` from `Action.CurrentInvocationKey`. The execution id is in the key because a keyed `sealed` action's invocation key is a cross-run cache key (`F/engine/src/FlowEngine/ActionKey.ts:173-245`), so without it two runs could share a write (Sol's catch). The attempt, the owner and the payload are not in the key.
- **Names are unique within a step.** A loop names each write by a stable id from the payload (`comment/${path}`).
- **`once`'s order.** find → found: adopt; none: perform → success; failure: find → found: adopt; none: the perform failure. Span `Action.once` with `smithers.effect.name` and `smithers.effect.outcome` (`performed`, `adopted`, `adopted_after_failure`, `failed`); counter `smithers_flow_effects{name, outcome}`. The key is never logged or used as a metric label.
- **The step's declaration.** A step whose writes all go through `once` declares `tier: "irreversible"` and an `idempotencyKey`: a repeat is safe, so the durable engine re-runs an unsettled crossing and `once` finds the write.

### 4.2 Adapter contract

1. `perform` puts the key on the object in the request that creates it.
2. `find` matches the key, and the acting principal where the provider shows one; never a title, a message, a time window, "latest" or a name alone.
3. `find` answers `None` only after a complete search. A search cut short by a page budget fails typed; a lookup that can't decide yet fails retryable.
4. One request per call; the step's retry policy is the only retry.

### 4.3 GitHub adapters, `@smthrs/integrations` `GitHub.Once`

| Adapter | Key on the object | `find(key)` |
|---|---|---|
| `branch({ owner, repo, prefix, label, at })` | name `${prefix}${label}-${key.slice(0, 12)}` | `GET git/matching-refs/heads/${prefix}`: the ref ending `-${key12}`. `at` is an Effect read only when the branch is made, so a retry after the default branch moved finds the first branch |
| `commitOnBranch({ owner, repo, branch, expectedHeadOid, headline, body, additions, deletions })` | trailer `Smithers-Write: <key>` | head = `expectedHeadOid` → none; head carries the trailer → its sha; else fails `conflict` (the branch moved under someone else). `expectedHeadOid` keeps GitHub from appending twice |
| `pull({ owner, repo, head, base, title, body })` | body marker | `listPulls({ head, state: "all" })` → the earliest with the marker; a truncated list fails |
| `issue({ owner, repo, title, body, since })` | body marker | issues since `since` (a durable time, such as when the write was admitted) with the marker; truncated fails |
| `comment({ owner, repo, number, body })` | body marker | the whole thread (no time window) → the earliest with the marker; truncated fails |
| `review({ owner, repo, number, ... })` | body marker | every review → the earliest with the marker; truncated fails |

## 5. Disagreements, decided

| Question | Sol | Opus | Decided | Evidence |
|---|---|---|---|---|
| Shape | `ExternalEffect.make`: one write per action, a new action kind with adapter kinds (Atomic, Reconcile, Unkeyed, Convergent), a required delivery policy, and new engine phases (`prepared`, `dispatching`) | `Action.once` inside any step, on today's engine | `Action.once` now | the engine already journals `intended` before an irreversible body and refuses a keyless repeat (`ActionPersistence.ts:2142`); a keyed write that looks itself up first needs no new phase. Sol's phases change the engine, the engine store, the Cloudflare host and the browser host, and no call site today needs them. Revisit when a keyed write must be at most once against a provider whose lookup can lag |
| Key material | execution id + invocation key, full digest, `sfx1-` prefix | invocation key + name, 32 hex | execution id + invocation key + name, 64 hex, no prefix | Sol is right that a keyed sealed action's invocation key is a cross-run cache key (`ActionKey.ts:173-245`); the name is what lets one step make two writes; the version is in the preimage |
| Lookup answer | `Found / Absent / Pending / Conflict` | `Option`, failing when unsure | `Option`, and the adapter's error channel carries `Pending` (retryable) and `Conflict` (not) | the same four outcomes, without a second result type next to Effect's error channel |
| Marker found twice | `identity_conflict`, stop | earliest wins | earliest of the acting principal's wins, counted as `duplicate` | a duplicate means the in-flight race already happened; stopping strands the run, and with the author check a copy by someone else can't match |
| Absent after a possible send | stop as unknown unless the declaration says at least once | perform again | perform again for marked writes; fenced writes can't duplicate | GitHub REST lists read their own writes; the only duplicate is a request still in flight past the client's timeout, which `Actions.ts:27-31` already documents as narrow |
| Payload bound to the key | yes: changed bytes refuse | no | no, and a Jev rule: a keyed write's inputs come from the step's payload or earlier recorded steps | binding needs stored intent per write; the first write wins on adoption either way |
| Publish split into commit, PR and projection actions | yes | no | no | with `once`, a projection failure retries the step and finds the commit and PR; nothing repeats |
| Merge attribution (#10) | trailer in the merge commit message | document | Sol's, later: `commit_message` carries `Smithers-Write` for merge and squash; rebase stays "merged, author unknown" | GitHub's merge API takes `commit_message` for merge and squash |
| A once-per-issue comment (#7) | a dedicated child execution keyed by repo and issue, so the effect key comes from that execution | none | Sol's, later | it makes a domain-wide "once" an execution identity instead of a content key |
| Lint | a new member-access rule that also catches aliases | `forbidCalls` | `forbidCalls` now plus a Jev item; the alias-proof rule later | `forbidCalls` matches `GitHub.Pulls.createPull` as written in every app call site today (`Todo.ts:445-536`, `Write.ts:213-226`, `Triage.ts:366-629`, `Checks.ts:243-253`) |

## 6. Migration, one commit per area

1. **`@smthrs/flow`:** `Action.once`, `keyed`, `effectKey`, `EffectKeyUnavailable`; docs (implement-an-action, reference); changeset.
2. **`@smthrs/integrations`:** `GitHub.Once` adapters and `Refs.listBranches(prefix)`; the finders fail on truncation; `Refs` and `Commits` docs point at `GitHub.Once`; changeset.
3. **TODO (`Todo.ts`):** `begin` makes its branch with `GitHub.Once.branch` (no suffix probing, no per-TODO shortcut, the base read only when the branch is made); `publish` makes the commit with `commitOnBranch` and the PR with `pull`; `Begin` and `Publish` become `irreversible` with an `idempotencyKey` of the attempt, and their implementation versions go to `todo/begin/v2` and `todo/publish/v2`, so a run parked on the old plan stops with `plan_changed` instead of resuming under different recovery. Regression: a foreign commit with the same number, title and login on the branch is never adopted.
4. **GitHub writes (`Write.ts`, `Triage.ts`, `Checks.ts`):** these writes already had identities chosen before the write, and some are read back (the projection joins a GitHub item to its write by `Write.ts`'s write id, `M/worker/github/Store.ts:28-30`), so `once` takes them as recorded keys: `Action.once(name, adapter, { key })`. `Checks.ts`'s review (key: the check's id) and `Triage.ts`'s repro request (one per issue) and rejection comment (the decision's id) are on `once`; the SDK finders fail instead of answering none past their page budget, and `Triage.ts`'s 91-minute window is gone. `Write.ts` and `Merge.ts` move onto `once` with the github-writes builder's review fixes.
5. **Notifications (`SpendAlert.ts`, `Channels.ts`):** each channel's send is its own `irreversible` step keyed by the alert and the channel, declared at least once (a duplicate alert beats a lost one, Will's "alert on any model spend"); email keeps the alert's id as Resend's `Idempotency-Key`. The notifications guide says how a step declares at most or at least once.
6. **Also done:** Code Storage branch create answers `409 exists` for a name the forge has and the app doesn't track (#11); `UpsertComment`/`CheckRun` keys default to the execution (#22, #23); `SandboxMerge.apply` requires a key (#27); `smthrs stack submit` finds its change's pull request by the change id's marker (#28); flows-ui names an agent's draft by its execution (#14). Still open: the merge trailer (#10, with `Merge.ts`) and `LinkPullRequest`'s fenced PATCH (#24).

## 7. Lint rule

`durable.external-writes-once`, in `M/docs/rules.md`, enforced in `M/PACKAGE.ts`:

- **`ImportRules` `forbidCalls`** over the app's sources: `GitHub.Refs.createBranch`, `GitHub.Commits.createOnBranch`, `GitHub.Commits.getCommit`, `GitHub.Pulls.createPull` and `GitHub.Pulls.findPullByHead`; `GitHub.Once` is the only way the app makes a branch, a commit or a pull request. Issue, comment and review creates join the list when `Write.ts`, `Triage.ts` and `Checks.ts` move onto `once` (section 6, item 4).
- **Jev asks:** "Does this file, after a write to another service may have happened, decide whether it happened by searching for an object by its title, message, name, parent, a time window or 'the latest', or by reading back state, instead of calling `Action.once` with an adapter keyed by the step's effect key?"
- **Limit:** an alias (`const { createComment } = GitHub.Issues`) escapes `forbidCalls`; the Jev item catches it until `ImportRules` gains a member-access rule.

## 8. Test plan

No mocks: faults come from injected Effect services; GitHub is the scripted GitHub on the `HttpClient` seam the app's tests already use (`M/worker/github/test/scriptedGitHub.ts`).

- **`@smthrs/flow` unit (100% of the module):** the key is 64 hex, stable for one dispatch and name, distinct per name, per invocation key and per execution; `once` adopts what `find` answers without `perform`; performs when `find` answers none; after a failed `perform`, adopts what a second `find` answers, else fails with `perform`'s error; a failing `find` fails without `perform`; no dispatch identity dies `EffectKeyUnavailable`; spans and counters carry the name and outcome, never the key.
- **On the durable engine (`@smthrs/engine-store`, SQLite, two incarnations on one file, as `HostedEngine.test.ts` does):** crash before the write (the first incarnation stops before `perform`; the second performs once); crash after the write and before the record (the first incarnation writes and stops; the second adopts it: one object, `CurrentRedispatch` true); crash during the record (a `succeeded` crossing settles without running the body; an `intended` crossing re-runs it and `once` adopts).
- **`@smthrs/integrations`:** each adapter against a scripted GitHub: the key lands in the trailer, marker or name; find matches only the key; a foreign object with the same title, message or name is never found; truncation fails; the commit adapter fails `conflict` when someone else moved the head.
- **TODO (on the Node host's engine over real Postgres):** the regression (a foreign commit with the same number, title and login is not adopted: today's code adopts it, so the test fails on main); a lost commit answer and a lost PR answer are adopted by key, one each; a branch made before a retry is found after the default branch moved.
- **E2E:** the TODO and GitHub write specs keep passing; no UI changes.
