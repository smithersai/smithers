---
name: smithers-memory
description: Change Smithers agent memory namespaces, model-facing remember/recall, durable storage, or recall policy.
---

# Agent memory

Read [the memory README](../../../packages/smithers/agent/memory/README.md) and its policy/durability guides before changing memory flows or stores. Bind model-facing `remember` and `recall` with `Flows.handlersFor` so the policy namespace is enforced before I/O; bare handlers and direct recall/store APIs are unscoped. A delegated flow tree should inherit one explicit memory policy.

The SQL store is authoritative; `TestMemory.layer` is volatile test storage. Preserve same-id write conflicts, append-only note supersession, and the recall byte budget before text enters a prompt. Opening context needs a frozen snapshot that remains stable across resume when the host supplies `SnapshotRecorder`. Verify namespace refusal, idempotent writes, and resumed context with meaningful tests.
