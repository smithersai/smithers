---
title: "Run sub-agents"
description: "Sub-agents are one ordinary catalog entry: the agent call runs a nested chain in the same journal under a derived child id."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/chain/docs/guides/sub-chains.md"
---

`SubChains` adds sub-agents as one ordinary catalog entry named `agent`. A
script spawns a child the way it calls anything else; the handler runs a
nested chain in the SAME journal under a deterministic child id, so a
re-executed spawning call resumes the child from its own settled events.

## Mount the recursive catalog

`SubChains.layer` builds the catalog: your entries, plus the `agent` entry,
plus the system entries. It needs the same `Journal`, `Author`, and
`ScriptRunner` instances the chain runs on, because it captures them at
construction. Build it over the same base layers with `Layer.provide`:

```ts
import { Author, Journal, QuickJsRunner, ScriptRunner, SubChains } from "@smthrs/chain"
import { Layer } from "effect"

const base = Layer.mergeAll(
  Journal.layerMemory(),
  authorLayer,
  QuickJsRunner.layer()
)

const catalog = SubChains.layer({
  entries: hostEntries,
  maxLinks: 16,
  maxCallsPerLink: 32
}).pipe(Layer.provide(base))

const layers = Layer.mergeAll(base, catalog)
```

A catalog built over a second set of layers would run its children against a
different journal than their parent.

## Call the agent

The `agent` entry takes `{ goal, context? }` and returns the child's terminal
outcome as data the parent script inspects:

````ts
const script = [
  "```flow",
  `const child = await ctx.call("agent", { goal: "count TODOs", context: ["look in src"] })`,
  `if (child._tag !== "Done") return park(child.reason.code, child.reason.message)`,
  "return done({ child: child.value })",
  "```"
].join("\n")
````

The child id derives from the spawning call slot: `parent-chain/link.ordinal`
(`1.0` for the root chain's link 1, ordinal 0). The child's events are scoped
by that id, so parent and child share one journal without sharing one scope.
Children run unattended: their explicit child role disables steering.
Named roots still drain their mounted steering service.

## Budgets, depth, and the contract digest

`SubChains.Options` carries per-child budgets (`maxLinks`,
`maxCallsPerLink`), a `prefix`, and `maxDepth` (default 4), the nesting bound
counted in derived child segments. All of them are part of the agent entry's
contract digest (`SubChains.contractDigest`), so redeclaring the child
budgets, prefix, or depth bound re-keys every settled spawn. A spawn deeper
than the bound fails the call with a `CallError`.

Spawning is a process-spawn-shaped authority: the entry claims
`proc:spawn:agent` (`SubChains.agentCapability`), which your authorization
rules must cover when gate 4 is mounted. The child's own calls are gated
individually by the same seam.

## What the child's terminal becomes

- A child's `done` and every terminal `park(...)`, including
  `park("approval")`, settle as data on the parent call. The parent script
  reads the outcome and decides.
- An unsettled `ApprovalWait` from a child must not settle as data. It bubbles as a
  `CallError` whose `cause` is `approval_required`, parking the parent in
  place; a later grant resumes the child through the same slot.
- A failing child RUN (journal integrity, seat outage, seam outage) is never
  journaled as a rejection. Its original typed error reaches the parent
  caller with its `_tag`, `code`, and `cause` intact. The spawning call stays
  unsettled; fixing the cause and resuming re-enters the child at its settled
  prefix. Only the child's terminal is data.

## Configuration rules

- Host entries may not shadow the reserved names (`agent`, `author`,
  `sys/now`, `sys/random`): the catalog dies at construction.
- Root chain ids must not contain `/` or look like `<digits>.<digits>`: the
  derived child id grammar owns those shapes. `Chain.run` refuses them with
  `ChainError` code `invalid_journal` before reading or writing the journal.
  The empty root id and names such as `root-a` are valid.

For the journal scopes children write under, see
[The journal](/concepts/journal/). For the authorization rules, see
[Authorize calls](/guides/authorization/).
