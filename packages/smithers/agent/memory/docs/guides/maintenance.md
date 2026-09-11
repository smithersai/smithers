---
title: "Run maintenance passes"
description: "Keep memory bounded with the three finite maintenance Effects: TTL garbage collection, history token limiting, and compaction."
sidebar:
  order: 5
---

`Maintenance` exports three finite Effects that keep memory bounded. None of them runs on its own: each performs one pass and returns a count, so you schedule them yourself, on a cron, after a run, or wherever your host keeps periodic work. Each needs only `MemoryStore.MemoryStore` in context.

## Collect expired facts

`Maintenance.ttlGc` deletes every fact whose TTL has elapsed, together with its full text projection and its vector rows, in one transaction:

```ts
import * as Maintenance from "@smthrs/memory/Maintenance"
import { Effect } from "effect"

const collected = Effect.gen(function*() {
  const result = yield* Maintenance.ttlGc
  // result: { deletedFacts: 2 }
  return result
})
```

Facts expire relative to their last update, and expired facts are already invisible to reads; this pass reclaims their storage and keeps recall projections honest.

## Limit history by approximate tokens

`Maintenance.limitHistory` deletes the oldest messages in every thread until each thread fits an approximate token budget:

```ts
const trimmed = Effect.gen(function*() {
  const limited = yield* Maintenance.limitHistory({ maxTokens: 4096 })
  // limited: { deletedMessages: 37 }
  return limited
})
```

The approximation is character-based: a thread's budget is `maxTokens * charsPerToken` characters, with `charsPerToken` defaulting to 4. A non-finite or negative `maxTokens`, or a non-positive `charsPerToken`, fails with `invalid_argument` and a path to the field. Characters are JavaScript string length, so an astral character such as an emoji counts as two. Threads are processed one at a time. One SQL aggregate per thread (`MemoryStore.messageStats`) settles every thread that fits by stored bytes, and every all-ASCII thread exactly, without reading message bodies. Other threads page through the store 256 messages at a time, and deletion reads only the oldest pages it removes.

## Compact old history into a summary

`Maintenance.compact` summarizes the old messages of each thread and atomically replaces them with one summary message. You supply the summarizer, so the pass works with a model flow, a test fake, or any route you own:

```ts
import * as Maintenance from "@smthrs/memory/Maintenance"
import { Effect } from "effect"

const summarized = Effect.gen(function*() {
  const compacted = yield* Maintenance.compact({
    summarizer: {
      summarize: ({ rendered }) => Effect.succeed(`Earlier: ${rendered.length} characters of discussion.`)
    },
    keepRecent: 2
  })
  // compacted: { compactedThreads: 3, deletedMessages: 41 }
  return compacted
})
```

- `threadId` restricts the pass to one thread; omit it to compact every thread.
- `keepRecent` messages stay untouched, defaulting to 2. A thread with no more messages than that is skipped, and so is a thread whose only old message is a system message.
- `maxMessagesPerSummary` bounds one summarizer call, defaulting to 1024 and at least 2. Longer histories compact in several windows, oldest first: each window becomes one summary, and the next window folds that summary in with the next oldest messages, so the thread ends with one summary. `deletedMessages` counts every deleted row, including folded summaries, so a summary id must differ per window; the default id does.
- The summarizer receives the thread id, the old messages, and their rendered `role: text` lines, and answers the summary text.
- The summary lands as a `system` message timestamped at the oldest removed message, with the id `makeSummaryId` returns. The default id derives from a digest of the thread and message ids, so a retried pass targets the same summary.
- The summarizer runs before the write transaction. After it succeeds, `MemoryStore.compactMessages` checks the immutable `sourceMessages` snapshot against the stored rows, then inserts the summary and deletes the sources in one durable write, so a failure or interruption before that commit leaves the source messages intact. A missing or changed source fails with `compaction_conflict`; read and summarize the current history again. Concurrent appends outside the snapshot remain intact. A summary id that already exists fails with `idempotency_conflict`, even on an identical retry. See [Troubleshooting](../troubleshooting.md#idempotency_conflict) to check a compaction after a lost response.

## Next steps

- Write the history these passes trim: [Store facts, notes, and history](./store-facts.md).
- Read the operation contracts: the [API reference](../api.md).
