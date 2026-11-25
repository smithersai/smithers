# 0170: SQLite shards replace Electric on the operational sync path

Date: 2026-11-24. Status: accepted (Gate 1, approved by Will 2026-11-24, recommended options 1A and 2A).
Nothing in this record is built yet.

## Context

Operational sync runs through Electric and Neon Postgres. One Electric container serves every user, reserves 21 Neon
connections, and loses its disk on restart, so every client refetches. Before keep-warm, 12 of 12 idle loads recorded
503s. A self-hosted node cannot run it without Postgres logical replication and Docker.

POC-1 (Node 26, SQLite 3.53.4, `@tanstack/db` 1.0.0-rc.1.5) ran the proposed design: 200 of 200 fuzz traces converged
byte for byte, 39,499 duplicate deliveries produced 0 duplicate rows, 578 hub restarts produced 0 refetches, and a cold
restart sent 10.18% of the bytes a full refetch sends.

## Decision

1. Operational state moves to event-sourced SQLite shards built on `@smthrs/journal` and `@smthrs/sync`. Electric
   leaves the operational path.
2. Each shard has exactly one sequencer per epoch, which assigns a monotonic `hubSeq` and a unique
   `(originNodeId, commandId)` receipt. Clients use Push, Pull and Follow, and a reconnect always resumes through Pull.
3. One shard per repository, plus isolated person-private shards. Cloudflare Durable Object SQLite sequences hosted
   repositories. A self-hosted repository can be sequenced by its own node and mirrored to `smithers.sh`.
4. Neon Postgres keeps hosted auth, the waitlist and the rebuildable cross-repository index, and nothing else.
5. The browser reads shards through one custom TanStack DB `createCollection` adapter over local SQLite.
6. The reducer is pure (`decide` and `evolve`, no IO or clock) so Lean 4 can prove domain and replication invariants
   and differential fuzzing can run the same traces in Lean and TypeScript.

## Consequences

- Durable Object SQLite takes `{ storage: ctx.storage }`, never `{ db: ctx.storage.sql }`, because only the first
  supports `withTransaction`. It refuses raw `BEGIN IMMEDIATE`, so the journal's busy paths become no-ops there.
- Migration runs in six slices: classify the 55 migrations, ship the Plan Tree shard, move messages, move the outbox,
  move the remaining shapes, then delete `ElectricGateway`, the Electric container, `@smthrs/effect-electric` and the
  replication slot.

## Rejected

- Keeping Electric for the quiet launch: it keeps the restart refetch and the shared connection pool.
- Multi-master CRDTs for everything: without a total order, run leases, Plan Tree cycle checks and a single external
  publish are impossible. CRDTs stay inside the stream for co-edited draft text.
- Postgres as the sequencer: it re-couples commits to a pool that already exhausted its connections once.
