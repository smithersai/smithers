---
title: "The trampoline"
description: "A chain is links, outcomes, and four gates. Continuation is whatever the link returns."
sidebar:
  order: 3
---

There is no agent-loop object. A chain is a trampoline over links, and
continuation is whatever the link returns.

## Links and outcomes

A link either runs its authored script to an outcome, or, when it has no
script (bootstrap) or its script was rejected by a gate, asks the author seat
for a successor built from the goal plus the journaled observations. Three
outcomes end a link:

- `done(value)` ends the chain. The run resolves to it.
- `to(script)` authors the next link: the chain journals `LinkAuthored` for
  the successor and `LinkEnded` for the current link, then advances.
- `park(code, message)` suspends the lineage with a typed reason
  (`approval`, `event`, `timer`, `quota`, or `plugin`). Parked lineages
  stop; waking them is out of this package's scope.

`done` and `park` are the terminal outcomes a run resolves to. A replay of a
finished chain returns its terminal without executing anything.

## The four gates

Every call a script issues crosses up to four gates. A call the gates admit
settles as a journaled `CallSettled`; a call a gate rejects journals a
`GateRejected` observation at that ordinal instead, and the next author reads
it as context.

| Gate             | Where                 | What it rejects                                                                         |
| ---------------- | --------------------- | --------------------------------------------------------------------------------------- |
| 1. Shape         | `Script.extract`      | An author reply that is not exactly one fenced `flow` block.                            |
| 2. Budget        | `Chain.run`           | A link past `maxLinks`, or a call past `maxCallsPerLink` or the tree's `maxTotalCalls`. |
| 3. Catalog       | `Catalog.lookup`      | A call naming an entry the catalog does not carry.                                      |
| 4. Authorization | `Authorize.authorize` | A call whose declared capabilities the host's policy denies, or parks pending approval. |

Three exceptions to "a rejection is an observation" are deliberate. A denied
model seat propagates typed, because routing around a denial by authoring
again would burn tokens on a chain that cannot author. A required approval
parks the run in place WITHOUT a `LinkEnded`, so resuming re-executes the
link from its settled prefix and re-asks the seam under the current grants.
And a call rejected by gate 2's per-link budget parks the chain with a
`quota` reason: the observation is journaled, but the link is out of fuel, so
there is no next author to read it.

## Recovery authoring

When a gate rejects a call, or a script fails (compile, runtime, or an
outcome that is not `done`, `to`, or `park`), the link does not crash the
run. The rejection or failure becomes a journaled observation, the link
aborts, and the harness issues a recovery author call whose context is the
goal, the caller's own context lines, and every observation of the link
rendered as `[kind] message`. The model reads what went wrong and authors a
successor that routes around it. A failing handler, a value that will not
serialize, and a denied or unknown catalog call all take this path.

The loop is bounded by the two budgets: `maxLinks` (default 32) caps how many
links a chain may bounce through, and `maxCallsPerLink` (default 64) caps the
calls one link may issue. Crossing either parks the chain with a `quota`
reason rather than looping forever.

For the outcomes and their constructors, see the
[API reference](../api.md). For the design in full, see
[The chain contract](../contract.md).
