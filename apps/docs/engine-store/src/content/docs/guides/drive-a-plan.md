---
title: "Drive a plan to completion"
description: "Record a plan, supply a node executor, run the graph, and read every node's outcome: admission caps, rebase budgets, conflict strategies, and reconciliation verdicts."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine-store/docs/guides/drive-a-plan.md"
---

`PlanScheduler` drives a persisted [`@smthrs/plan`](https://plan.smithers.sh/reference/api/) plan. It owns
identity, admission, caching, and journaling, and deliberately owns nothing
about what a node means: turning a node into work is the one seam you supply.

## Supply an executor

`NodeExecutor` is that seam. It receives a `NodeInput` and returns whatever the
node produces:

```ts
import { PlanScheduler } from "@smthrs/engine-store"
import * as Effect from "effect/Effect"

const executor = PlanScheduler.layerExecutor({
  execute: (input) =>
    Effect.succeed({
      node: input.node.id,
      attempt: input.attempt,
      inputs: input.inputs.map((resolved) => resolved.value)
    })
})
```

`NodeInput` carries the `PlanNode`, the `attempt` number, the `boundary` this
dispatch was keyed under, and the node's material `Ref` inputs already resolved
through the same projection the key digests. Ordering dependencies and
unprojected sibling fields are deliberately absent: an executor may only see
data the key folds, or a cached settlement could be served for an execution that
consumed something else.

## Build the scheduler and run the plan

```ts
const scheduler = PlanScheduler.layer({
  runId: "plan-1",
  owner,
  sourceId: "planner",
  concurrency: { steps: 8, agents: 2 },
  rebaseLimit: 3
})
```

`concurrency.steps` caps leaf execution and `concurrency.agents` caps the agent
subset within it. Both default to unbounded and both reject zero, because a cap
of zero admits nothing and a round that admits nothing settles nothing. Invalid
bounds are rejected at construction: both must be positive safe integers, and
`rebaseLimit` a non-negative one.

The service has three members:

```ts
interface Service {
  readonly record: (plan: Plan) => Effect<RecordResult, SchedulerError, PlanStore | Journal | Crypto>
  readonly append: (plan: Plan) => Effect<void, SchedulerError, PlanStore | Journal | Crypto>
  readonly run: (plan: Plan) => Effect<Report, SchedulerError, Requirements>
}
```

`record` persists generation 0 and journals `plan-recorded`. `append` persists
the newest generation and journals `subgraph-appended`. `run` walks the graph
and returns a `Report`.

Both plan records carry the graph itself under `graph.nodes`, beside the node
count `nodes` has always been, and each node names the tag it dispatches. They
carry no edges: a plan names its edges through each node's `dependsOn`, and the
reason for an edge is something only an interpreted graph knows.

The runtime requirements include `PlanInputStore.layer` and `PlanMergeStore.layer`. Compose them over the
same database and durable writer as the other stores, with `Crypto`, after
`Migrations.layer` has installed the schema. `TestStores.layer` and `layerAt`
already provide both. There is no volatile fallback: missing durable observations
must not authorize fresh execution of an old action.

## Read the report

`Report` carries the `planId`, its `digest`, one `Settlement` per node, the
`results` by node id, the reconciliation `verdicts`, and the ids of any merge
nodes a `stop-merge` conflict appended.

Each `Settlement` names the `planKey` (a pure function of declarations), the
`dispatchKey` actually dispatched under, the `attempts` and `rebases` spent,
and one of five outcomes:

| Outcome    | Meaning                                                                           |
| ---------- | --------------------------------------------------------------------------------- |
| `built`    | The node executed and succeeded.                                                  |
| `clean`    | A durable attempt replay or eligible shared-cache hit served it; no executor ran. |
| `failed`   | The node executed and failed, or reconciliation failed it.                        |
| `skipped`  | A dependency prevented dispatch, or `stop-merge` stopped a dispatched attempt.    |
| `deferred` | A selection guess postponed it. It never dispatched and wrote no cache row.       |

Every settlement is journaled as `node-settled`. A `stop-merge` decision writes
one `skipped` settlement for the stopped node. Reopening the run preserves that
record; recovery writes it only if it was missing. A `deferred` node is never
reported as passed, and is a debt a later guess-free pass repays.

## Why the dispatch key is not the plan key

All effect tiers can be planned. Sealed work uses the content-derived dispatch
key described below. Compensable and irreversible work instead uses a run-local
key scoped by the plan, structural node address, and declaration fingerprint.
Its successful attempt can replay after a restart in that run; it cannot serve
a different invocation or publish to the shared cache. Repeated identical
non-sealed nodes are distinct invocations.

Compensable attempts use the supplied `Jj` pre-image and restore it before a
retry. That promise covers only state the snapshot actually captures. The
generic node executor does not supply an irreversible idempotency contract, so
uncertain recovery and retries of irreversible work are refused, including
automatic conflict rebases or merge elaboration. No tier turns approval into authority or makes an
unenforced boundary hermetic.

The sealed dispatch key folds the node's own declaration with measured file
digests and the projected values of its material `Ref` inputs. It does not fold
upstream plan keys: unchanged consumed content can reuse a result even when an
upstream declaration changed. Ordering dependencies do not expose their values
to the executor. Two runs whose input files differ can declare the same graph,
so a plan key alone cannot establish reuse.

Source inputs have no writer preceding their reader. They include reads before
an explicitly later writer and reads of a node's own future writes. Their bytes
and glob membership are pinned before the first dispatch; new generations are
observed at append time. Produced inputs are measured after preceding writers
settle. A rebase re-observes those outputs, never source inputs.

`PlanInputStore` persists these observations before any affected dispatch.
Reopening the same run recovers them without measuring source files or expanding
source globs again. Each generation keeps earlier pins and records only new
sources. The same run cannot silently switch plan IDs or approved base graphs;
start a new run for changed work. A new run observes the current inputs.

The scheduler copies `Options.environment` at construction and persists its
normalized fingerprint with the first input generation. Same-run recovery
refuses changed identity before execution, for sealed, compensable, and
irreversible work. Equivalent capability-pattern sets recover normally; layer
order matters. Omission is a distinct identity, not a wildcard. Use the original
runtime to recover, or reconcile unfinished effects before starting a new run.
This cannot detect behavior changes a host omits from its declared identity.

Upgrade boundary: runs with attempts predating migration `3003` have no reliable
source snapshot and are refused by this scheduler. Finish them on the prior
runtime before upgrading, or explicitly decide how to recover their effects
before starting new work. Deleting the compatibility marker is not recovery.
Migration `3004` likewise refuses existing input heads with no recorded
environment. It preserves their unknown state instead of guessing a binding.

## Readiness, ordering and recovery

Each run or resume builds a private `RuntimeGraph` from the verified plan and
recovered merge settlements. Stable plan positions, forward and reverse edges,
unresolved and blocking dependency counts, and an explicit remaining count
replace repeated whole-plan readiness scans. State and admission membership use
maps and sets. The indexes are not persisted or included in any key.

A dispatch result stays provisional while the coordinator drains and reconciles
its durable deviations. Only the reconciled settlement updates affected
dependents. Retry attempts and rebases hold the same node in flight; they do not
decrement its dependents' counts again. Skips propagate in dependency order
before more work is admitted. A failed cone does not stop unrelated work. A
selected sink becomes deferred only if its dependencies succeeded; a failed
cone produces skipped work rather than selection debt.

Ready work is ordered by declared `priority` plus one point for each admission
pass in which capacity left it waiting. Ties retain compiled plan order, and
priority arithmetic stays exact even at the safe-integer boundary. Every
admission re-ranks the current frontier, accounting for its updated ages. A
blocked agent does not prevent ordinary steps from using spare step permits.
This preserves fairness; a wide frontier can still cost proportional to its
size, plus sorting, on each admission.

An appended generation enters the indexes synchronously after the plan, input
observations and merge completion commit together. Earlier positions, states
and observations remain intact. Discovered reconciliation edges change only
readiness; declared predecessors still determine file versions. Ancestor
queries visit each reachable predecessor once per reader and release their
temporary set, rather than retaining a transitive-closure matrix.

Reverse indexes govern readiness and propagation of settled outcomes only.
Content addressing and the existing cache-admission checks still govern reuse.
There is no separate dirty-bit propagation or cache-invalidation visitor.

The scheduler's differential tests retain the pre-index coordinator in
`test/PlanSchedulerReference.ts`. Generated DAGs compare complete reports,
dispatch and settlement records, input projections, plan generations and cache
keys. Separate cases control concurrent completions, reopen real SQLite
connections, and compare exact, tree and glob file scopes against independently
specified source and producer measurements. `RuntimeGraph.test.ts` also compares
each frontier with an exhaustive state model.

Private work counters separate index updates, settlements, frontier snapshots,
admission preparation and ancestor queries. Allocation counts cover explicit
graph containers and records, not VM backing storage, closures, the shared
admission policy, or persistence and filesystem work. Chain and wide-frontier
tests assert operation counts instead of elapsed time. The optional
`node test/RuntimeGraphBenchmark.ts` measures only graph mechanics locally,
checks equal admission order before timing, and is not an end-to-end scheduler
throughput claim.

## Handle a conflict

The runtime conflict strategies ride the plan's pair annotations:

- **delay and rebase** holds the dependents and re-executes against the newly
  recorded base. The re-measure re-keys, so it is a new attempt rather than a
  retry of one identity. It is journaled as `node-invalidated` and bounded by
  `rebaseLimit`, because an unbounded rebase loop is a livelock with good
  manners.
- **stop and merge** stops the loser and appends a merge node to the same plan
  as an ordinary elaboration, with no rebase budget of its own: a lane that
  loses a landing race restarts or fails rather than rebasing.

A conflict neither strategy absorbs goes to `Reconciliation`.

The scheduler persists the stopped-attempt decision independently of the
action's failure and redacted journal. Recovery preserves that node as `skipped`
and reuses completed work instead of re-executing it. It accepts either the
original approved base or a loaded grown plan, but validates the recorded
parent digest, generated node identity and intervening approved generations.
Missing or inconsistent recovery data is an error, not permission to invent
an extension.

Generated display IDs start at `${nodeId}+merge` and use a free numeric suffix
when user-defined nodes occupy that name. A name or merge-shaped body alone
does not establish generated ownership: the durable decision does. The input
generation, plan append, journal publication and merge completion commit
together. A failed append leaves a recoverable intent, not a partial extension.

Generated merges count toward `Plan.maximumPlanNodes`. If an extension would
exceed that limit, the scheduler returns `elaboration_failed` without committing
a new generation. Leave capacity for possible merge nodes in very large plans.

Migration `3005` preserves unknown merge state for pre-existing input heads;
the scheduler refuses them rather than guessing which failures were absorbed.
Recover those runs with their original runtime, or reconcile their effects
before starting new work. These scheduler guarantees do not establish native
filesystem merge correctness or make arbitrary external effects reversible.

## Install a reconciler

`Reconciliation` answers a `Deviation` or a `Conflict` with a `Verdict`:

```ts
import { Reconciliation } from "@smthrs/engine-store"

const reconciler = Reconciliation.layerDefault
```

`layerDefault` is deterministic, in this order of preference:

- `Reorder` when every undeclared path is one another plan node declares it
  writes. That is a real dependency the declaration missed, made explicit.
- `FactorOut` when another node in the same run deviated on exactly the same
  paths. Content addressing collapses two identical extracted steps to one key
  by itself, so the verdict is a record and a hint.
- `Fail` otherwise, because a deviation nothing explains is genuinely wrong. A
  conflict the runtime strategy could not absorb always fails here: choosing a
  winner between two landings is a semantic judgement this default does not
  have the material to make.

The scheduler attributes every deviation on a journal page before judging any of
it, so two steps that produced the same undeclared paths both see each other.
Deviating identically is a symmetric fact, and which of the pair the journal
happened to list first must not decide the verdict.

`Reconciliation.layer(service)` installs your own. Pluggability here is
dependency injection at the owning seam; there is no hook kernel. A model-backed
reconciler is a different `Layer` and lives in the agent packages, because this
package carries no model dependency.

## What a SchedulerError is, and is not

`SchedulerError` is a refusal the scheduler itself raises, with a `code` of
`invalid_plan`, `boundary_unavailable`, `key_uncomputable`, `elaboration_failed`, or
`store_failed`. A node's own failure is not one of these: the run continues and
the report says `failed`.

## Related

- [Defer work with selection](/guides/defer-work-with-selection/): what a
  `deferred` outcome means and how the debt is repaid.
- [Cache admission](/concepts/cache-admission/): why a node settles `clean`.

### Plan admission and filesystem failure cleanup

`record`, `append`, and `run` verify the complete plan before using it. They
recompute keys, graph annotations and approval digests through `Plan.verify`,
then use its immutable snapshot. Each operation requires `Crypto`; invalid
input fails with `invalid_plan` before store calls, journal writes, filesystem
measurement or dispatch. Caller mutation cannot change an admitted plan.

A source or produced-file enumeration failure carries `boundary_unavailable`
and its original cause. Consumers whose inputs cannot be measured never get
an attempt or cache entry. A typed scheduler failure interrupts siblings and
atomically marks their still-owned running attempts failed with matching
`attempt-finished` journal records. Completed producer evidence remains valid.
A terminal row or lost owner fence is never overwritten.

If cleanup itself cannot commit, the original scheduler error remains primary
and its `cleanupErrors` records those failures. Journal failure rolls back the
attempt transition. Such an unresolved attempt needs recovery; the scheduler
does not claim that failed persistence succeeded. Ordinary parking, external
interruption and ownership-loss semantics are unchanged.

The run driver owns the RunStore lifecycle transition when `run` fails; this
scheduler does not terminalize the run itself. Missing glob roots and absent
exact producer paths intentionally mean zero matches (including removals);
disappearance of a subtree that enumeration already discovered is an error.
