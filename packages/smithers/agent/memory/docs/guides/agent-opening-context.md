---
title: "Give an agent opening memory"
description: "Read a frozen, byte-capped memory snapshot for an agent's opening context with Source, and record it across processes with SnapshotRecorder."
sidebar:
  order: 4
---

`Source` reads a memory snapshot for an agent's opening context: primer notes plus recalled rows, fetched once per retry identity, bounded in bytes, and frozen so a retry reads the same rows the first attempt read. The value feeds `Agent.Options.memory` from [`@smthrs/agent`](/api/agent), which renders it with `Source.render`. A judged run's relevance reading judges each row and may withhold some.

## Read the declared snapshot

Call `Source.declared` with a source and an input. The answer is the exact `{ rows, digest }` shape `Agent.Options.memory` accepts:

```ts
import * as Source from "@smthrs/memory/Source"
import { Effect } from "effect"

const opening = Effect.gen(function*() {
  const memory = yield* Source.declared(Source.source, {
    lineageId: "run-42",
    iteration: 0,
    banks: ["flow-release-notes"],
    query: "changelog",
    primerBanks: ["global-primers"],
    maxTokens: 2048,
    maxBytes: 8192
  })
  // memory: { rows: [{ origin: "primer", bank, key, text }, ...], digest: "..." }
  // Source.render(memory.rows): "<flows_memory_context>\n...\n</flows_memory_context>"
  return memory
})
```

The input extends the recall input, so `banks`, `query`, `tagGroups`, `maxTokens`, and `budget` all behave as they do for the `recall` flow. Two fields are new:

- `lineageId` and `iteration` form the retry identity. The first successful read for an identity fetches; later reads answer the frozen rows. A failed read remains retryable.
- `maxBytes` caps the complete fenced render, defaulting to 16,384. It is a separate ceiling from `maxTokens`, which caps only the recalled rows. A cap too small for the fence and the first row's label yields no rows. Non-finite caps use the default.

Primer banks default to `banks` when omitted. Each bank reads a newest-first window of notes through `searchRows` with `kinds: ["note"]`, with a row limit derived from `maxBytes`, the fence size, and the minimum rendered primer label size. Only accepted, non-superseded notes render as primers. Facts never enter the window, so a bank that keeps receiving facts still renders its primers.

Primer banks retain input order after alias deduplication. Within each bank, newer notes survive truncation ahead of older notes, with ties ordered by key. Primers come before recalled rows. The byte cap keeps the beginning of that order, so earlier banks take priority; the first row that does not fit whole is cut to what does, at a code point, and ends the snapshot. The limit bounds returned candidates, not SQL work or the size of one stored note.

The effect needs `MemoryStore.MemoryStore` and `Recall.Recall` in context. `Source.readRows` is the same read without the memo or the recorder.

```ts
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import { Layer } from "effect"

const layers = Layer.provideMerge(RecallKeyword.layer, TestMemory.layer)
```

## What the freeze promises

Every source has an in-process memo (`Source.make` accepts a `capacity`, defaulting to 1,024 identities). With no recorder in context, that memo is the whole guarantee: reads of one identity through one source return the same rows while that identity stays within the capacity. The memo evicts the least recently used identity once it holds more than `capacity`, and the next read of an evicted identity fetches current memory. A second source always refetches live memory. Supply a durable `SnapshotRecorder` for retry stability beyond the memo's lifetime. Only the first read for an identity honors the banks, query, tag groups, primer banks, and budgets; a later read that changes them logs a warning naming the changed fields and answers the frozen rows.

A read fails typed rather than answering empty rows: one that exceeds two seconds fails with `TimeoutError`, and a store or recall failure fails with its `MemoryError`. The host decides what a run without its memory does. Fiber interruption propagates unchanged, so cancellation still cancels.

With a recorder, a failure cancels the pending record and removes the local memo entry. A later read for the identity retries, including after a process restart. A successful empty snapshot is still recorded. Without a recorder, a failure removes the process-local memo entry the same way, so a later read in the same process retries.

## The fence is a delimiter, not a trust boundary

Rows are model-written: a remembered fact or an accepted note holds whatever the agent read, and the snapshot is replayed into every later run's first message. The fence therefore only marks where the snapshot starts and ends. It does not make the text inside it trustworthy, and a host must not treat fenced text as instructions.

What `Source.render` does guarantee is that only it writes a fence or a label. Before a row is rendered, every character that could open a fence, start a `[primer:bank]` or `[bank/key]` label, or end the line is replaced with its visible `\uXXXX` escape:

- In text: `\`, `<`, `[`, and the line terminators CR, LF, NEL, LS, and PS.
- In a bank or key label: the same set plus `]`, `:`, and `/`.

So one row is always one line, a `</flows_memory_context>` inside a row renders as `\u003c/flows_memory_context>`, and a row cannot forge an attribution line. The byte cap counts escapes at their rendered size and never cuts one.

## Record the snapshot across processes

Memory text goes into an agent's opening context, so it is part of the very first message of the conversation. A resumed run replays a model call it already made only when the input reaching that call is identical, and the opening context is part of that input. So a resumed run that fetches memory again and gets different rows repeats, and pays for, every model call underneath it. `SnapshotRecorder` is the optional port that closes that gap:

```ts
import * as SnapshotRecorder from "@smthrs/memory/SnapshotRecorder"
import { Effect } from "effect"

const recorder = SnapshotRecorder.SnapshotRecorder.of({
  record: (identity, effect) =>
    // return the value held for identity, or evaluate and record `effect`
    effect
})
const layer = SnapshotRecorder.layer(recorder)
```

With a recorder in context, the first fetch for an identity goes through its boundary, and a second source, including one built by a resumed process, receives the recorded rows instead of refetching. The production adapter is `@smthrs/agent/MemorySnapshotRecorder.layer`, which implements this port through the engine; see the [`@smthrs/agent` API](/api/agent). A memory-only composition supplies no service and keeps the process-local memo.

## Next steps

- Pick what the snapshot ranks: [Recall memory](./recall-memory.md).
- Understand why frozen context matters: [durable execution](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine/docs/README.md) on smithers.sh.

## Ranked opening memory and skills

The root `Opening` namespace exports `Sources`, `layerSources(banks, skills)`
and `select`. The host authorizes the bank list; direct recall remains unscoped.
`layerSources` reads the injected durable `Recall` service and joins optional
skill candidates. An additional source, such as a future wiki, implements
`Sources` without changing the selector or importing a filesystem.

`select` keyword-shortlists at most 30 candidates across memories and skills,
reserving half for each kind before filling unused slots,
asks the injected judge once, sorts retained verdicts by increasing probability
of being unnecessary, and packs whole rows. Invalid and duplicate verdicts are
ignored. The budget includes the complete escaped `Source.render` output.
UTF-8 bytes conservatively bound tokens by default; a host can inject a tokenizer.
Oversized rows are skipped so smaller relevant rows still fit. Failures and
cancellation propagate; the selector supplies no retry or persistence mechanism.
Seal its output in a flow action before starting the agent so resumed runs keep
the exact opening context. Pass retained rows through `AgentAction.memory`.
Never place memory or the question in telemetry.

`Opening.boundedQuery` retains the newest query context within the recall UTF-8
limit, preserving whole code points. Bound long conversation context before
calling recall or the judge so a long history cannot fail the recall input cap.
