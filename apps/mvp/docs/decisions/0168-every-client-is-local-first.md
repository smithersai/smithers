# 0168 — Every client is local-first

Date: 2026-11-16. Status: accepted (Will's words in chat; rulings CORE-13 to CORE-16).

## Context

[Decision 0167](0167-one-core-clients-and-hosts.md) set one core, clients and a
tree of hosts. It left two questions open: whether a client cut off from its
host keeps working, and whether two clients' data syncs in both directions. The
documenting agent proposed one owner per record, with every other client
following read-only and changes sent to the owner as commands.

Will rejected that proposal as a rule. Ownership is a detail; the architecture
is local-first.

## Decision

1. Every client is local-first and follows all the rules of local-first
   (CORE-13). ARCH-5, ARCH-12 and ARCH-18 already made the app local-first; this
   extends it to every client: a laptop, a sandbox, a server, Smithers cloud.
2. Feature code writes to the file system and to SQLite or Postgres. The sync
   engine is a background concern that is never programmed per feature
   (CORE-14).
3. The product handles conflicts and clients that are offline (CORE-15).
4. Multiplayer, routing through a host and syncing between clients are
   supported (CORE-13).
5. A record can live on a client only, or on the client and its host, the way a
   branch can be private or always synced. The product makes that choice formal
   (CORE-16).

```
 feature code ──▶ this client's files and database ──▶ sync engine ──▶ host ──▶ other clients
 writes locally,                                        background,
 never mentions sync                                    conflicts and offline handled
```

## Why the one-owner proposal lost

One owner per record forces every feature to know who the owner is and to send
commands to it. That is sync programmed per feature, which CORE-14 forbids. It
also breaks the local-first rule that a client's own writes succeed while it is
offline.

One part of it survives as an implementation fact, not a rule: a run executes on
one client, so that client appends the run's history. An append-only history
needs no conflict handling; it syncs like any other data.

## Consequences

- A feature that contains its own sync, retry-to-server or conflict code is
  built wrong.
- Every record type needs a stated behavior when two clients change it while
  apart. The sync engine applies it; the feature does not.
- A client that runs sandboxes on a host cannot reach them while disconnected
  from that host. This follows from the architecture and needs no rule.
- The sync engine is the largest open engineering choice. It must serve a tree
  in which a client that holds SQLite is itself a host. Today the core follows a
  run's journal read-only (`@smthrs/sync`), and `apps/mvp` syncs Postgres to
  the browser through Electric, which reads from Postgres only. Neither is the
  engine CORE-14 describes.

## Open

Section 18 of [the rulings](../rulings.md): which sync engine, how private
against shared is formalized, and whether two clients may sync with no host
between them.
