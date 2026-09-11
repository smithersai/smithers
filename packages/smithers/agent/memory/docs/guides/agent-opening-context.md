---
title: "Give an agent opening memory"
description: "Build a frozen, byte-capped memory snapshot for an agent's opening context with Source, and record it across processes with SnapshotRecorder."
sidebar:
  order: 4
---

`Source` renders a fenced memory snapshot for an agent's opening context: primer notes plus recalled rows, fetched once per retry identity, capped in bytes, and frozen so a retry reads the same text the first attempt read. The value feeds `Agent.Options.memory` from [`@smthrs/agent`](/api/agent).

## Build the declared text

Call `Source.declaredText` with a source and an input. The answer is the exact `{ text, digest }` shape `Agent.Options.memory` accepts:

```ts
import * as Source from "@smthrs/memory/Source"
import { Effect } from "effect"

const opening = Effect.gen(function*() {
  const memory = yield* Source.declaredText(Source.source, {
    lineageId: "run-42",
    iteration: 0,
    banks: ["flow-release-notes"],
    query: "changelog",
    primerBanks: ["global-primers"],
    maxTokens: 2048,
    maxBytes: 8192
  })
  // memory: { text: "<flows_memory_context>\n...\n</flows_memory_context>", digest: "..." }
  return memory
})
```

The input extends the recall input, so `banks`, `query`, `tagGroups`, `maxTokens`, and `budget` all behave as they do for the `recall` flow. Two fields are new:

- `lineageId` and `iteration` form the retry identity. The first successful read for an identity fetches; later reads answer the frozen text. With a recorder, a degraded fetch remains retryable.
- `maxBytes` caps the complete fenced snapshot, defaulting to 16,384. It is a separate ceiling from `maxTokens`, which caps only the recalled rows. A cap too small for the fence itself yields empty text. Non-finite caps use the default.

Primer banks default to `banks` when omitted. Each bank reads a newest-first candidate window through `searchRows`, with a row limit derived from `maxBytes`, the fence size, and the minimum rendered primer label size. Only accepted, non-superseded notes render as primers. The window includes facts, which occupy candidate slots but do not render as primers; use note-focused primer banks when that distinction matters.

Primer banks retain input order after alias deduplication. Within each bank, newer notes survive truncation ahead of older notes, with ties ordered by key. Primers render before recalled rows. The byte cap keeps the beginning of that ordered text, so earlier banks take priority, and the final row may be partial. The limit bounds returned candidates, not SQL work or the size of one stored note.

The effect needs `MemoryStore.MemoryStore` and `Recall.Recall` in context and never fails:

```ts
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import { Layer } from "effect"

const layers = Layer.provideMerge(RecallKeyword.layer, TestMemory.layer)
```

## What the freeze promises

Every source has an in-process memo (`Source.make` accepts a `capacity`, defaulting to 1,024 identities). With no recorder in context, that memo is the whole guarantee: two reads through one source return the same text, while a second source refetches live memory. Only the first read for an identity honors the banks, query, tag groups, primer banks, and budgets; a later read that changes them logs a warning naming the changed fields and answers the frozen text.

The snapshot degrades rather than fails: a fetch that exceeds two seconds or fails with a typed error yields empty text and a warning log. The warning includes elapsed milliseconds, requested primer and recall bank counts, and per-bank candidate limits and observed row counts (`null` means the read did not finish). These are bounded read sizes, not total bank sizes. Fiber interruption propagates unchanged, so cancellation still cancels.

With a recorder, degradation cancels the pending record and removes the local memo entry. A later read for the identity retries, including after a process restart. A successful empty snapshot is still recorded. Without a recorder, the process-local memo retains degraded empty text as before.

## The fence is a delimiter, not a trust boundary

Rows are model-written: a remembered fact or an accepted note holds whatever the agent read, and the snapshot is replayed into every later run's first message. The fence therefore only marks where the snapshot starts and ends. It does not make the text inside it trustworthy, and a host must not treat fenced text as instructions.

What the render does guarantee is that only `Source` writes a fence or a label. Before a row is rendered, every character that could open a fence, start a `[primer:bank]` or `[bank/key]` label, or end the line is replaced with its visible `\uXXXX` escape:

- In text: `\`, `<`, `[`, and the line terminators CR, LF, NEL, LS, and PS.
- In a bank or key label: the same set plus `]`, `:`, and `/`.

So one row is always one line, a `</flows_memory_context>` inside a row renders as `\u003c/flows_memory_context>`, and a row cannot forge an attribution line. The byte cap is applied after escaping and may end the snapshot inside an escape.

## Record the snapshot across processes

Memory text goes into an agent's opening context, so it is part of the very first message of the conversation. A resumed run replays a model call it already made only when the input reaching that call is identical, and the opening context is part of that input. So a resumed run that fetches memory again and gets different text repeats, and pays for, every model call underneath it. `SnapshotRecorder` is the optional port that closes that gap:

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

With a recorder in context, the first fetch for an identity goes through its boundary, and a second source, including one built by a resumed process, receives the recorded text instead of refetching. The production adapter is `@smthrs/agent/MemorySnapshotRecorder.layer`, which implements this port through the engine; see the [`@smthrs/agent` API](/api/agent). A memory-only composition supplies no service and keeps the process-local memo.

## Next steps

- Pick what the snapshot ranks: [Recall memory](./recall-memory.md).
- Understand why frozen context matters: [durable execution](/docs/concepts/durable-execution/) on smithers.sh.
