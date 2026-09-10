---
title: "Persist grants across restarts"
description: "Use JournalGrantStore so a remembered decision survives the process: the two run ids, what replay accepts and refuses, and how to keep the policy journal inside its ceiling."
sidebar:
  order: 4
---

The in-memory store forgets everything when its scope closes. `remembered`
means nothing until something writes it down. `JournalGrantStore` is that
something: it persists each decision to a [`@smthrs/journal`](/api/journal)
journal **before** activating it, and replays the history when the next
process builds a store.

## Build it

```ts
import { JournalGrantStore } from "@smthrs/kernel"

const store = JournalGrantStore.layer({
  // The operational run. Run grants and run envelopes live here.
  runId: "run-2026-09-03-a",
  // The dedicated policy run. Remembered grants live here, and this id stays
  // stable forever, because the journal has no global grant projection.
  policyRunId: "kernel-policy",
  // The producer id. Replay activates events from this source and no other.
  sourceId: "my-host/grants",
  // Binds run grants and run envelopes to the exact active plan.
  planDigest: "plan-abc",
  attended: true,
  rules: [configuredPolicy]
})
```

The layer requires `Journal` and `Workspace`. `runId` and `policyRunId` must be
different, and every identity must be non-empty, well-formed text within
`GrantStore.maximumIdentityLength`.

`rules` here is the nested form: an array of rulesets whose first entry is your
configured policy. Replayed remembered rules are appended as a further ruleset,
so your configured deny keeps its hard veto over anything replay activates.

The journal is authoritative permission storage. `SqlJournal` must use the
`reject` overflow policy: a dropped grant decision cannot safely be treated as
persisted, so drop-capable policies are unsupported.

## Persist first, activate second

Every decision commits to the journal before `GrantStore` activates it. A
journal failure becomes `journal_failed` and the decision stays **inactive**,
so a permission that could not be written down is a permission that was not
granted.

Events are routed by scope. Remembered grants and remembered envelopes go to
`policyRunId`; once, denied, run, and run envelope events go to `runId`. They
are written unfenced: the grant store is the kernel's own ledger rather than a
run's lifecycle, and admissions are first-writer-wins records that every later
process replays.

## What replay accepts

Replay is not a general read of the journal. It activates only what it can
prove:

- **Only the configured `sourceId`.** Events from another producer are
  ignored, so nothing else writing to the same journal can grant kernel
  authority.
- **Only the five known event types.** Anything else in the run is ignored.
- **Only correctly scoped events.** A run-scoped event found in the policy run,
  or a remembered event found in the operational run, refuses construction
  rather than being skipped.
- **Only the current plan.** A run grant or run envelope whose `planDigest`
  differs from the store's is skipped: it authorized a different plan.
- **Only safe patterns.** Every replayed grant pattern is rechecked with
  `isValidGrantPattern`, and every envelope pattern with
  `isValidEnvelopePattern`. A pattern that would exceed its request refuses
  construction, so a tampered journal cannot widen authority.

Once and denied events are **audit evidence only**. They record what happened;
they activate nothing.

Two failures refuse construction outright rather than degrading: a payload that
does not decode, or whose envelope type disagrees with its own payload type;
and a journal page that does not advance past the cursor it was asked for.
Following a non-advancing page would replay the same events forever, and
accepting it would double-apply them.

Replayed rules are deduplicated by formatted pattern identity, so a capability
granted a hundred times costs one rule.

## Compact the policy journal before it fills

A store retains at most `GrantStore.maximumRules` rules and the same number of
envelope signatures. Because the policy run accumulates forever, that ceiling
is a real operational limit, and `JournalGrantStore` fails closed when replay
would exceed it. The failure names the policy run and the counts, so you know
what to compact:

```text
policy run kernel-policy replayed 1024 remembered rules; configured rules (12)
and replayed run rules (3) bring the total to 1039, which exceeds the
1024-rule ceiling, so compact the policy journal
```

The envelope-signature ceiling produces the matching message. A construction
envelope is refused rather than persisted once the replayed signatures already
fill the ceiling, so the history a later process must replay cannot outgrow
what it will accept.

## Concurrent construction on one Journal service

Two constructors sharing one `Journal` service instance could both replay the
absence of the same construction envelope and both persist it. A critical
section per service instance re-replays the target run inside the lock, so
exactly one of those constructors appends the envelope and the others replay
it instead. An envelope whose signature is already durable activates its rules
without persisting again.

The lock stops at the service object. Two processes, or two `Journal` services
over one backing journal in one process, hold separate locks, and the envelope
event carries no journal dedupe key, so both can append it. The duplicate is
harmless to authority: replay collapses identical envelopes into one signature
and the same rules. It costs one extra row per race, so build the store once
per process and share the service where construction can overlap.

## Related

- [Answer permission requests](./answer-permission-requests.md): where
  `remembered` decisions come from.
- [How a grant decision is made](../concepts/grant-decisions.md): what replay
  is rebuilding.
