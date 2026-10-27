---
title: "What memory persists"
description: "The records @smthrs/memory keeps across runs: namespaces and banks, facts, notes, threads, and the JSON and TTL rules that shape them."
sidebar:
  order: 1
---

`@smthrs/memory` persists three record kinds in SQLite: facts, notes, and message threads. Every record lives in exactly one namespace, and a record written by one run is readable by every later run that opens the same database file. Storage is SQLite through [`@smthrs/database`](/api/database), and `MemoryStore.layer` applies the package's migrations idempotently when it builds, so the store creates its own tables on first use.

## Namespaces and banks

A namespace is a structured value `{ kind, id }`. The `kind` names the record's lifetime, and four stable lifetimes exist:

| Kind     | The lifetime it names                               |
| -------- | --------------------------------------------------- |
| `flow`   | one flow's private memory                           |
| `agent`  | one agent's memory across the flows it runs         |
| `user`   | one user's memory across agents                     |
| `global` | memory shared by everything that opens the database |

A bank is the public string spelling of a namespace, the form a model writes and a recall request carries. A prefixed bank such as `flow-release-notes` or `global-history` names an explicit lifetime; an unprefixed bank such as `release-notes` is flow-local and resolves to `{ kind: "flow", id: "release-notes" }`. Because `release-notes` and `flow-release-notes` resolve to the same namespace, every read that accepts a list of banks de-duplicates on the resolved namespace rather than the spelling.

`Bank.parse` is the validating reader for bank strings and rejects an empty bank with `invalid_namespace`. Accept a structured namespace anywhere the store takes `NamespaceInput`; the store validates it the same way.

## Facts

A fact is a namespaced key and a JSON value with last-write-wins update semantics. `putFact` upserts; `getFact` answers the current value or `undefined`.

Two rules shape what you get back:

- The value is serialized through a `JSON.stringify` round trip at write time. `NaN` and `Infinity` become `null`; `undefined`, function, and symbol members disappear; sparse array slots become `null`. A later `getFact` can therefore return a value that differs from the input. The value is serialized once at API entry, and the stored JSON, the search text, the retained tags, and any vector projection all come from that one snapshot.
- An optional `ttlMs` expires the fact that many milliseconds after its last update. Expired facts are invisible to `getFact` and `listFacts` even before garbage collection removes them, and every update restarts the clock. `Maintenance.ttlGc` deletes the expired fact, its full text projection, and its vector rows in one transaction.

A fact also carries first-class tags, validated against the tag vocabulary, and the provenance the writer bound: run id, node id, and iteration.

## Notes

A note is an append-only text record with an id, a tag list, provenance, and a status. The id is global, not namespaced: `getNote` finds a note by id alone.

Status is the only mutable field, and it moves through a gate: `pending`, `accepted`, or `rejected`. A note enters as `accepted` unless the writer says otherwise. Reads default to `accepted`, so a note an evaluation has not judged yet stays out of recall until something calls `setNoteStatus`.

Supersession is how an append-only log corrects itself. A new note can declare `supersedes` edges to older notes in the same write transaction, and `supersede` adds an edge later. A note with an accepted superseder drops out of default reads; pass `includeSuperseded` to see it. A superseder that is still `pending` or `rejected` hides nothing. Contradicting what is already stored, reusing an id with different creation data, self-supersession, and edges across namespaces all fail with `supersede_conflict`.

## Threads and messages

A thread is an ordered history of messages, each with a caller-chosen id, a role, text, and a timestamp. Threads exist so agents can keep conversation history durable across runs.

A message id is unique within its thread, not globally. Appending the same id with the same role, text, and timestamp is a no-op, which is what makes a retried append safe. Appending the same id with any difference fails with `idempotency_conflict` and a path to the first field that differs. `appendMessage` creates a missing thread for you, in the `global` namespace under the id `history`; call `createThread` first when the thread belongs somewhere else. Creating a thread is itself idempotent on identical creation data.

`appendMessageOnce` accepts the same identity, role and text with an optional
timestamp and returns the stored message. The first insertion chooses the
timestamp inside the write transaction. Later and overlapping retries that
omit it reuse that value. Explicitly conflicting timestamps, roles or text
still fail; `appendMessage` retains its required-timestamp contract.

## What durability does not mean

The store is the authority; recall is advisory. Recall bindings read the store and rank what they find, and the opening snapshot `Source` builds is a frozen copy meant for prompt stability, not a second source of truth. [How recall works](./recall.md) covers that side. For the limits every read enforces, see the [API reference](../api.md).
