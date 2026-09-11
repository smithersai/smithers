---
title: "Import surface"
description: "The exports map of @smthrs/memory: root namespaces, per-module subpaths, the test layer, and the blocked paths."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/memory/docs/surface.md"
---

The root entry point exports every public module as a namespace. Each module is also importable from its own subpath, which is the form this site's examples use.

```ts
import { Flows, MemoryStore } from "@smthrs/memory" // root namespaces
import * as Flows2 from "@smthrs/memory/Flows" // the same module, subpath form
```

## Modules and subpaths

| Module             | Import specifier                  | Summary                                                                           |
| ------------------ | --------------------------------- | --------------------------------------------------------------------------------- |
| `Bank`             | `@smthrs/memory/Bank`             | Validating public bank-name constructors                                          |
| `Database`         | `@smthrs/memory/Database`         | Public database port used by SQL-backed memory adapters                           |
| `Embedding`        | `@smthrs/memory/Embedding`        | Provider-neutral embeddings used by semantic memory recall                        |
| `Flows`            | `@smthrs/memory/Flows`            | Memory flow declarations and runtime bindings                                     |
| `Maintenance`      | `@smthrs/memory/Maintenance`      | Finite memory maintenance Effects intended for explicit schedules                 |
| `MemoryError`      | `@smthrs/memory/MemoryError`      | Stable memory failures                                                            |
| `MemoryStore`      | `@smthrs/memory/MemoryStore`      | Authoritative SQL memory contract store                                           |
| `MemoryTrellis`    | `@smthrs/memory/MemoryTrellis`    | A Trellis whose generated work inherits one memory policy                         |
| `Migrations`       | `@smthrs/memory/Migrations`       | Registered memory schema for standalone and shared database composition           |
| `Namespace`        | `@smthrs/memory/Namespace`        | Structured memory namespaces and tag-group matching                               |
| `Recall`           | `@smthrs/memory/Recall`           | The replaceable memory-recall seam                                                |
| `RecallFts`        | `@smthrs/memory/RecallFts`        | SQLite FTS5 recall binding                                                        |
| `RecallKeyword`    | `@smthrs/memory/RecallKeyword`    | Keyword recall with no host dependencies                                          |
| `RecallSemantic`   | `@smthrs/memory/RecallSemantic`   | In-process semantic recall and best-effort vector projection                      |
| `Source`           | `@smthrs/memory/Source`           | Advisory memory context source for an agent's opening context                     |
| `SnapshotRecorder` | `@smthrs/memory/SnapshotRecorder` | Host boundary for freezing an opening memory snapshot beyond the fetching process |
| `WithMemory`       | `@smthrs/memory/WithMemory`       | One memory policy applied to a whole flow tree                                    |

The [API reference](/reference/api/) documents every export of every module.

## The test layer

`@smthrs/memory/test/TestMemory` is published separately as the in-memory test layer. It provides the authoritative SQL store over a fresh in-memory database with deterministic test services.

## Blocked paths

Two subpath forms resolve to nothing on purpose:

- `@smthrs/memory/internal/*`: shared implementation, not contract.
- `@smthrs/memory/*/index`: there are no nested index modules.

`@smthrs/memory/package.json` is exported for tooling that reads package metadata.
