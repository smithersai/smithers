# @smthrs/memory

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact `4.1.1` peer dependency. Install one
`effect` release at that version so all Smithers packages share one Effect
runtime.

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/agent/memory/docs

Durable memory for an AI agent: facts, notes, and message threads kept in
SQLite, ranked for recall, and reachable by a model through two operations it
calls by name, `remember` and `recall`.

A model's context window disappears when the process exits. Everything the next
run should still know has to live outside the model, and this package is that
store. It ships as Effect services, so you choose the storage and the recall
algorithm your host can support and every caller keeps working.

## Install

```bash
npm install @smthrs/memory@next effect
```

Name `@next`: npm's `latest` tag still carries the `0.x` line, the previous
generation of the package, which has a different API.

It needs Node.js 22.19.0 or later and `effect` `4.1.1` as a peer. The full
requirements, and the two packages a file-backed store adds, are on the
[installation page](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/memory/docs/installation.md).

## Write a fact and recall it

```ts
import * as Flows from "@smthrs/memory/Flows"
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import { Effect, Layer } from "effect"

const memory = Layer.provideMerge(RecallKeyword.layer, TestMemory.layer)

const program = Effect.gen(function*() {
  yield* Flows.runRemember({ bank: "global-notes", key: "release", text: "cut 0.1.0" })
  return yield* Flows.runRecall({ banks: ["global-notes"], query: "release" })
})

const rows = await Effect.runPromise(program.pipe(Effect.provide(memory)))
// [{ bank: "global-notes", key: "release", text: "cut 0.1.0", score: 1, updatedAtMs: ... }]
```

`global-notes` is a bank, the public string spelling of a namespace.
`TestMemory.layer` forgets everything when the process exits; swapping it for
`MemoryStore.layer` over a SQLite file is a one-layer change, and the
[quickstart](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/memory/docs/quickstart.md) walks that whole path.

## What the package gives you

- Scoped namespace isolation across `flow`, `agent`, `user`, and `global`
  memory. Bind a policy-carrying declaration with `Flows.handlersFor` to limit
  model-facing reads and writes to the policy namespace. An empty recall
  `banks` list defaults to the policy banks; `remember` requires a non-empty
  `bank`. Banks resolving to another kind or id fail with
  `invalid_namespace` before I/O. Equivalent bank spellings are allowed.
  Bare handlers and direct recall or store APIs remain unscoped.
- Recall as a replaceable service rather than one fixed algorithm. Keyword
  matching needs nothing beyond the store; SQLite or PostgreSQL full text search and
  in-process semantic search over embeddings are also included, and swapping
  between them changes no caller. Semantic recall searches all eligible records
  in the selected banks using bounded pages and retains only its result budget.
- A byte budget on every recall answer, because recalled rows are about to
  become part of a prompt.
- Idempotent writes. Re-appending an identical message is a no-op; re-appending
  the same id with different content fails with `idempotency_conflict` instead
  of duplicating history.
- Append-only notes that correct themselves by supersession, so an obsolete
  note drops out of recall without a destructive edit.
- One memory policy a whole flow tree inherits, including the work a delegated
  plan generates that nobody named.

## Public API

The root entry point exports these namespaces, and each is also importable from
`@smthrs/memory/<Module>`. Every export, with its signature and its guarantees,
is on the [API reference](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/memory/docs/api.md).

| Namespace          | What it is                                                                        |
| ------------------ | --------------------------------------------------------------------------------- |
| `Flows`            | The callable `remember` and `recall` declarations, and their runtime bindings.    |
| `WithMemory`       | One memory policy applied to a whole flow tree.                                   |
| `MemoryTrellis`    | A trellis whose model-authored work inherits one memory policy.                   |
| `MemoryStore`      | The authoritative SQL store: facts, notes, threads, messages, and search rows.    |
| `Namespace`        | Structured memory namespaces and tag-group matching.                              |
| `Bank`             | The validating reader for the public string spelling of a namespace.              |
| `Recall`           | The replaceable recall seam: the service, the slot, and the byte budget.          |
| `RecallKeyword`    | Keyword recall, needing nothing beyond the store.                                 |
| `RecallFts`        | SQLite FTS5 recall.                                                               |
| `RecallSemantic`   | In-process semantic recall and opt-in vector projection.                          |
| `Embedding`        | The provider-neutral embedding port semantic recall reads.                        |
| `Opening`          | Opening-context selection: injected sources, a keyword shortlist, a judged pick.  |
| `Source`           | The frozen, byte-capped memory snapshot an agent's opening context reads.         |
| `SnapshotRecorder` | The optional port that keeps that snapshot stable across a resumed process.       |
| `Maintenance`      | TTL collection, history limiting, and compaction, as finite Effects you schedule. |
| `Database`         | The public database port SQL-backed memory adapters accept.                       |
| `MemoryError`      | The one failure type, carrying a stable code and an optional field path.          |
| `Migrations`       | The registered memory schema for standalone and shared database composition.      |

`@smthrs/memory/test/TestMemory` is the in-memory test layer: the same
authoritative store over a fresh in-memory database. `internal/*`,
`migrations/*`, and nested `*/index` subpaths resolve to nothing on purpose.

## Documentation

- [Overview](https://github.com/smithersai/smithers/tree/main/packages/smithers/agent/memory/docs)
- [Quickstart](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/memory/docs/quickstart.md)
- [What memory persists](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/memory/docs/concepts/durability.md)
- [How recall works](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/memory/docs/concepts/recall.md)
- [Memory policies](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/memory/docs/concepts/policies.md)
- [Give an agent opening memory](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/memory/docs/guides/agent-opening-context.md)
- [Troubleshooting](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/memory/docs/troubleshooting.md), which lists
  every failure code, what causes it, and what to change.

## License

MIT. See [LICENSE](./LICENSE).
