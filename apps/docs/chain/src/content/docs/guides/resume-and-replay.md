---
title: "Resume and replay"
description: "Seed a journal, resume a crashed or parked chain, and read the replay_divergence failures that guard against stale results."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/chain/docs/guides/resume-and-replay.md"
---

`Chain.run` resumes from whatever the journal already holds. A finished chain
returns its terminal without executing anything; a half-finished link replays
its settled calls by ordinal, with zero effects, and then runs live. There is
no resume API to call: you run the chain again over the same journal.

Chain provides exactly-once replay of journaled settled calls and
at-least-once handler execution. A matching settled call replays its recorded
result without running its handler. If a handler succeeds but a crash or
append failure prevents `CallSettled` from being recorded, resume can execute
the handler again. Handlers must be idempotent or, for non-repeatable effects,
use an external durable idempotency key derived from the stable call identity
(`chain`, `link`, `ordinal` in `Catalog.CallSlot`).

`Chain.run` passes the slot as the handler's second argument. Reuse the key
on every attempt and have the external service durably deduplicate the effect
and return the recorded result. Namespace the key by the host's journal
identity when independent journals share an external service. Chain cannot
atomically commit an external effect together with `CallSettled`.

## Seed the journal

`Journal.layerMemory` takes an optional array of prior events. Seed it with
the events a previous run wrote (read them through `Journal.read` before the
process exits, or persist them in your own journal binding):

```ts
const resumed = Layer.mergeAll(
  Journal.layerMemory(priorEvents),
  authorLayer,
  QuickJsRunner.layer(),
  Catalog.layer(Catalog.withSystem(entries))
)

const terminal = await Effect.runPromise(
  Chain.run({ goal: "fix TODOs" }).pipe(Effect.provide(resumed))
)
```

The replay serves settled results from the journal without running their
handlers, replays recorded gate rejections as aborts at the same ordinals,
and re-executes only what never settled.

## The identity a run pins

`ChainStarted` pins the goal and the caller's envelope into the journal. A
resumed run compares both and fails with `replay_divergence` when either
differs, so one journal scope serves exactly one goal and one caller
identity. The envelope is any JSON value, journaled verbatim and never
redacted: keep secrets out of it. It is NOT a policy input; the `Authorize`
seam receives only the call's name, its declared capabilities, and the call
slot.

`Options.chain` names the journal scope a run owns (default `""`, the root).
Sub-chains derive theirs from the spawning call slot; see
[Run sub-agents](/guides/sub-chains/).

## What re-keys a settled call

A settled result replays only when the live call matches the journaled one
on every component of its key. Resume fails loudly instead of serving a
stale result when:

- the goal or envelope differs from the journaled `ChainStarted`
  (`replay_divergence`)
- the current link or script digest differs from the journaled call's
  (`replay_divergence`): editing one character of a script re-keys exactly
  the calls inside it
- the call requests a different entry name or a different payload than the
  journaled call at that ordinal (`replay_divergence`)
- the entry's CURRENT declaration digest differs from the journaled one
  (`replay_divergence`): renaming, re-describing, or changing an entry's
  capabilities re-keys its calls, as does a registry flow redeclaration, a
  memory-contract upgrade, or a change to sub-chain budgets
- the journal settles an author call whose result is not a script
  (`invalid_journal`)

## Parks and resume

`Chain.run` returns `Outcome.RunResult`: `Done`, terminal `Park`, or an
unsettled `ApprovalWait`. The journal and script outcome schemas are unchanged.
These shapes resume three ways:

- A script's own `park(...)` settles as a `LinkEnded` and replays as the
  terminal `Park`, even for `park("approval")`. Waking a parked lineage is out of this package's scope.
- An approval wait (the seam's `approval_required`, or a sub-chain bubbling
  one) returns `ApprovalWait` and journals nothing for the parked call. Resuming re-executes the link
  from its settled prefix and re-asks the seam under the current grants, so
  granting the claim and running again resumes through the same slot.
- A `quota` park (link budget or per-link call budget) settles as a
  `LinkEnded`. Raising the budget does not replay it: the park is terminal.
  To continue, start a new chain scope or accept the park as the outcome.

For the key's four components and the declaration rule, see
[Keyed replay](/concepts/keyed-replay/). For the failure taxonomy, see
[Troubleshooting](/troubleshooting/).
