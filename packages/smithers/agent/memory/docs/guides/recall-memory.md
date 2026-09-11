---
title: "Recall memory"
description: "Choose and wire a recall binding in @smthrs/memory: keyword, SQLite full text, or semantic, with budgets and tag filters."
sidebar:
  order: 2
---

Recall reads advisory rows out of named banks through one replaceable service. You pick a binding once, provide its layer, and every caller of the `recall` flow or `Flows.runRecall` uses it. [How recall works](../concepts/recall.md) explains the model; this guide wires it.

Every binding answers the same input:

```ts
import * as Flows from "@smthrs/memory/Flows"
import { Effect } from "effect"

const recalled = Effect.gen(function*() {
  const rows = yield* Flows.runRecall({
    banks: ["global-notes", "flow-release-notes"],
    query: "changelog",
    maxTokens: 2048,
    tagGroups: [{ tags: ["scope:project"], match: "any" }]
  })
  // rows: [{ bank, key, text, score, updatedAtMs? }, ...]
  return rows
})
```

`banks` accepts at most 16 names, de-duplicated on the resolved namespace. `maxTokens` is a UTF-8 byte ceiling over the serialized result array, at most 65,536; rows with empty text drop out before the budget fills. `tagGroups` accepts at most 16 groups, and every group must match a row's tags for the row to rank.

The example calls the unscoped `runRecall` and has no policy boundary. For model-facing access, bind a policy-carrying declaration with `Flows.handlersFor`, or call `Flows.runRecallFor`. An empty `banks` list then selects the policy namespace; every explicit bank must resolve to the same `kind` and `id`. Any foreign bank fails the whole request with `invalid_namespace` before the recall service runs. Equivalent bank spellings are allowed; there is no extra readable-bank list. `recall: "none"` returns no rows before bank validation. The policy budget fills an omitted `maxTokens`; an explicit budget still wins.

## Keyword recall

`RecallKeyword.layer` needs only the store. It scores each row by the number of normalized query terms occurring in its key and text, breaks ties by newest update, and applies the byte cap:

```ts
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import { Layer } from "effect"

const memory = Layer.provideMerge(RecallKeyword.layer, TestMemory.layer)
```

Pick keyword recall when you want zero moving parts: no enablement step, no embeddings, no provider. Both query and row text are normalized to NFKC before matching.

## Full text recall

`RecallFts.layer` ranks by SQLite FTS5 BM25. Enable FTS once per namespace kind before the first query, or the store fails the read with `fts_not_enabled`:

```ts
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as RecallFts from "@smthrs/memory/RecallFts"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import { Effect, Layer } from "effect"

const memory = Layer.provideMerge(RecallFts.layer, TestMemory.layer)

const setup = Effect.gen(function*() {
  const store = yield* MemoryStore.MemoryStore
  yield* store.enableFts("global")
  yield* store.enableFts("flow")
})
```

The store maintains the FTS projection on every write, so no reindex step exists. Pass the raw query string: the binding and the store share one escaper, and a query you escape yourself gets escaped again.

## Semantic recall

`RecallSemantic.layer` ranks rows by cosine similarity between each row's stored vector and the query embedding, decayed by a recency half-life. It needs an `Embedding` service and a vector store. The authoritative store writes no vectors itself, so decorate it: every `putFact` and `putNote` then projects a vector after commit, retrying once and logging failures without changing the write result. The projection runs in the caller's fiber under `projectionTimeout` (default 5 seconds), so a hung embedding provider delays the write by at most that deadline and is logged like any other failure. The vector upsert keeps the newest projection by `updatedAtMs`, so when two processes write the same record, a slower embedding for the older write cannot replace the newer vector.

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as Embedding from "@smthrs/memory/Embedding"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as RecallSemantic from "@smthrs/memory/RecallSemantic"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const program = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter.DurableWriter
  const store = yield* MemoryStore.MemoryStore
  const embedding = yield* Embedding.Embedding

  const vectorStore = RecallSemantic.makeSqlVectorStore({ sql, write: writer.write })
  const options = { vectorStore }
  const decorated = RecallSemantic.decorateStore(store, RecallSemantic.makeProjector(options), embedding)

  yield* decorated.putNote({
    namespace: "flow-bank",
    id: "note",
    text: "semantic note",
    tags: [],
    provenance: {}
  })

  return yield* RecallSemantic.recall({ banks: ["flow-bank"], query: "semantic" }, options)
}).pipe(
  Effect.provide(Embedding.layerInProcess),
  Effect.provide(TestMemory.layerWithDatabase)
)
```

`Embedding.layerInProcess` computes a deterministic 64-dimensional embedding with no provider, which makes the whole setup self-contained. To plug in a provider, implement `Embedding.EmbedMany` and pass it to `Embedding.layer`; an invalid batch from the provider fails with `embedding_unavailable`.

Three details shape the answers:

- Recall scans all eligible vectors in the selected banks under the model it was asked for, in bounded pages; `budget` limits results rather than restricting the search to recent records. `options.model` defaults to the in-process model, and a stored vector under that model with the wrong dimension fails with `vector_model_mismatch`.
- `input.budget` selects the result count deterministically: `"low"` answers 3 rows, `"mid"` answers 8, `"high"` answers 20. The byte cap still applies after the count.
- `options.halfLifeMs` controls the recency decay and defaults to seven days.

## Bind the slot in a flow graph

When a host composes flows rather than calling handlers directly, bind the flow-valued slot instead of providing the service. `Recall.slot` is the shared slot, and `Flows.bindRecall(supplied)` resolves it to a flow you supply. See the [`@smthrs/patterns` API](/api/smithers-patterns) for `Pattern.bind`.

## Next steps

- Enforce one namespace for a flow tree's recall and writes: [Scope a flow tree to a namespace](./scope-a-flow-tree.md).
- Freeze recall into an agent's opening context: [Give an agent opening memory](./agent-opening-context.md).
- Diagnose empty results: [Troubleshooting](../troubleshooting.md).
