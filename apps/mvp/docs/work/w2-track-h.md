---
title: Plan Tree shard and local node
status: done
area: sync
owner: codex
updated: 2026-11-24
links:
  - ../decisions/0170-sqlite-shards-replace-electric.md
  - ../decisions/0171-one-core-four-clients-and-workflows-dir.md
---

The Plan Tree uses the Cloudflare SQLite adapter and the shared sync sequencer. The app core stamps a cause before the commit and publishes only after it persists. Compaction retains the Plan Tree and its causes. A reader at the compaction floor continues from its cursor.

The local node uses the CLI's Node SQLite host and the shared shard client. Its stored outbox survives a restart. Attach uses the existing MCP stdio bridge, the worker's approval flow, and an explicit agent grant. The Plan Tree projection test uses the Effect TanStack DB journal collection.

Plan Tree grants carry `plan:read:<shard>` for projection, cause receipts, pull and snapshot, and `plan:write:<shard>` for mutations. The local node's MCP token grants append only. The replication credential grants read and submit on one shard and binds submission keys to the verified node. A separate local sync credential grants read and sync on that shard.

Replica SQLite binds once to the normalized hub origin. Opening a replica without a recorded origin fails closed. Sync returns the position and retained terminal refusals and conflicts. The shared `@smthrs/sync` client records those answers in the same transaction that removes their outbox commands. The client checks the shard on every submit reply, pull reply and snapshot before using it. The `@smthrs/platform-cloudflare` adapter reads legacy stream names and empty command-key elements, including from an existing unnamed shard. New submits still use the strict protocol schema.

An authority node commits each MCP acknowledgment and its cause with the shard entry. Verified duplicates return the saved position and output without publishing another run.

Attach redemption returns the Worker MCP route for the grant's repository and branch. The CLI forwards the grant to that same-origin route. Attach, Plan Tree MCP and local MCP enforce their body limits as bytes arrive.

The host registers the plan namespace and supplies repository-scoped credential verification. The CLI registers the node and attach command modules. This track leaves the shared entry points for their assigned tracks.
