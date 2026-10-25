# 0021: Local-first data migrates on every deploy

Status: being built; versioned device schemas, their migrations and fixtures are in `src/device/` (2026-10-21). Ruling ARCH-19. Will, 20:03 on Telegram: "when we deploy to prod we will have a frontend migration to do and in fact need a generalized way of handling migrations of our local first data that should be robust and make messing up hard". Builds on [0002](0002-local-first.md) (the device store and the outbox) and [0011](0011-the-agent-runs-in-the-browser.md) (the browser engine). Work note: [local-first migrations](../work/local-first-migrations.md).

A device's data opens only for its owner ([decision 0023](0023-device-ownership-and-queued-authority.md)); the rules below hold for ownership too. An earlier build's device belongs to the person its confirmed session names, and data whose owner isn't the person signed in stays sealed and whole, never deleted.

## The five rules

1. **Every store a device keeps declares its history.** Each persisted collection, each outbox payload and the engine's journal has an append-only list of versions, each an Effect Schema, and a pure migration between neighbors. The build stamps its version on everything it writes.
2. **The leader migrates before anyone reads.** The engine worker that leads runs `device/prepare`, a durable flow, before it serves the device store to any tab. Each store migrates in one SQLite transaction, so a crash leaves it at the old version or the new one, never between.
3. **Synced rows are dropped and resynced; local rows are migrated or kept.** A synced collection's new version drops its rows and Electric refetches them. A local-only row is migrated, or, when it can't be, kept aside with a diagnostic. No row is deleted without a record.
4. **An old build's pending write still sends.** Before the outbox loads its writes, each one from an older build is upgraded by its payload's migrations. One that can't be is parked and shown Not sent, with Retry or Edit, and Discard. No write is dropped.
5. **A schema change without a version fails CI.** A lock file records every persisted schema's fingerprint by version. Changing a schema without a new version, or adding a local version without a migration, fails `pnpm test`. Every migration runs in tests against fixtures of each deployed build's store.

## 1. What is versioned

| Store | Where | Its version | Stamped by |
|---|---|---|---|
| Synced collections (Electric) | OPFS `app.db`, TanStack DB's `collection_registry` | `schemaVersion` per collection id; a family such as `chat-messages:<conversation>` shares one | TanStack DB, as the collection registers |
| Local-only collections (drafts, `unsent`, `issue-requested`, preferences, summaries) | the same | the same | the same |
| Outbox writes | IndexedDB `smithers-outbox` | each payload collection's version, in the write's `metadata.versions`; a write without it is from before stamping and takes the declared `unstamped` versions | `Outbox.transact` |
| Engine journal and plans | OPFS `engine.db` | the engine store's own SQL migrations; each run's plan digest, without declaration sites or the build ([plan identity](../work/plan-identity-across-deploys.md)); each parked payload decodes against the current flow or refuses with `payload_changed` | `@smthrs/flows`' engine store |
| The device's epoch | derived | the sum of every store's version, plus one for each retired store. It only grows, so builds compare by it | the registry |
| `localStorage` | the theme's mirror, the wipe mark | none: one plain string each, rewritten on every boot | the app |

## 2. The migration model

**Declarations.** The app declares each store once, beside its schema, with `@smthrs/effect-tanstack-db`'s `Migrations`:

```ts
export const RequestedStore = Migrations.local({
  id: "issue-requested",
  versions: [RequestedV1, Requested],                    // version n is versions[n - 1]; append only
  migrations: [Migrations.step(RequestedV1, Requested, ({ via: _, ...row }) => row)],
  getKey: (row) => row.id,
})
export const ItemsStore = Migrations.synced({ id: "issue-items", version: 3, schema: Item })
Collection.persisted(RequestedStore)                    // the declaration is the collection's options
```

- A migration is a pure function from one version's decoded row to the next one's. It may refuse a row (`Migrations.Unmigratable`) when the new shape can't say what the old one meant. It never changes a row's key.
- `Migrations.registry` collects every store, the outbox's payload collections and mutation names, and the stores retired since (`Migrations.retired`), and derives the epoch.

**The runner.** `Migrations.apply(registry, sql)` reads `collection_registry` and, for each stored collection:

| Stored | Declared | Does |
|---|---|---|
| this build's version | any | nothing |
| an older version | synced | nothing: TanStack DB drops its rows and resume state when the collection opens, and Electric refetches |
| an older version | local, with migrations up to now | in one `BEGIN IMMEDIATE` transaction: decodes each row with its version's schema, applies each migration in turn, encodes it with this build's schema, writes it back under a new row version, then sets the collection's version |
| a newer or unknown version, or a row that won't decode or migrate | local | keeps each such row in `device_kept` (the raw value, its version and why), removes it from the collection, and records a diagnostic; the rest migrate |
| any | retired | keeps its rows in `device_kept` |
| any | not declared | nothing: a newer build owns it |

**A durable step in the leader.** `@smthrs/platform-browser`'s leader runs the app's preparation (`BrowserRuntime.run({ prepare })`) after it wakes unfinished runs and before it answers any tab's statement. It runs it as the flow `device/prepare`, executed once per epoch (`device/prepare/<epoch>`):
- **Idempotent.** Each store's transaction first rereads its version; a store already at this build's version is skipped. Running the flow again does nothing.
- **Resumable.** A crash rolls back the open transaction. The next leader's wake drives the unfinished run, which reruns the step; the stores that committed are skipped.
- **One writer.** Only the worker holding the engine's Web Lock runs it, and no tab's statement runs until it ends, so nothing reads a half-migrated store.
- **Fails closed** (changed 2026-10-21 from "never blocks the app", after the agent review found that serving a database the build could not prepare lets every statement run against an incompatible store). If the flow fails, the leader logs it, counts it, and refuses every tab's statement with `PrepareFailed`. `SharedSqlite.open` then rejects, so the app keeps its rows in memory and nothing reads or writes the device store for that build; its rows stay untouched for the next build, whose new epoch prepares again. The failed run is the epoch's answer, so every leader of the same build keeps the fence.

**Open tabs of the old build.** TanStack DB refuses every read and write through an adapter whose version no longer matches the stored one, so an old tab can't corrupt a migrated store: its writes to a changed collection roll back. To keep old tabs from running at all:
- The leader announces its epoch with `Ready`. A tab whose epoch is lower reloads, and gets the new build from the service worker. A tab whose epoch is higher than the leader's tells the older tabs to reload, and waits for a leader of its epoch; after `within` it falls back to memory, as when no leader answers. (Slice 2.)
- Builds before this one don't announce an epoch. For the first deploy, a new tab whose device store an old tab's worker serves sees its changed local collections fail to load until that tab closes; no data is lost.

## 3. Synced versus local data

- **Synced rows are a cache.** The server holds them, so dropping and resyncing is always correct, and it is the only path: no migration is ever written for a synced collection. Any schema change bumps its version. The cost is one refetch on the first open after the deploy.
- **Local-only data is the person's.** Drafts, `unsent` questions, `issue-requested`, preferences, local flows and pending outbox writes exist nowhere else. Each is migrated, or kept in `device_kept` with a diagnostic. Caches that are local but derived (the timeline's summaries) may declare `discard: true`, which still records the count.
- **Retiring a store is a declaration,** never a deleted line: `Migrations.retired({ id, versions })` keeps its rows. Moving data to a new home is the new home's job: on a branch its owner shared, the branch's prompt adopts the draft chat kept for that conversation (`chat-drafts`), merged with any text there, and deletes it ([coedit](../features/coedit.md)).
- **Kept rows are recoverable.** `device_kept` is part of the device's export ([device data recovery](../work/device-data-recovery.md)).

## 4. The outbox across a deploy

- **Stamp.** `transact` stores the version of each payload collection in the write's metadata. Mutation names and collection keys never change; a rename is declared (`renamed`).
- **Upgrade.** Before the executor starts, `Outbox.layer` reads every stored write and upgrades the ones an older build made: each row through its payload's migrations, then stamped and stored again. Upgrading twice is harmless. Two tabs upgrading at once write the same bytes.
- **Park.** A write naming a mutation or collection this build doesn't have, from a newer build, or whose row a migration refuses, moves to `parked:<id>` with why. The executor never loads it, so it is never sent wrong, and never lost. The app hands each parked write to its feature, which shows it Not sent: chat's question as an `unsent` row (Retry, Discard), an issue write as a `not_sent` request (`Not allowed`). `Outbox.parked` lists them; `discard` deletes one with a log line.
- **Never dropped.** The library skips a stored write it can't deserialize without telling anyone; the upgrade runs first, so it only ever sees this build's writes.

## 5. Safety rails

- **The lock.** `apps/mvp/src/device/schemas.lock.json` records, per store, each version's fingerprint: a hash of its Effect Schema's JSON Schema document. `src/device/schemas.test.ts` fails when:
  - a store's schema changed and its version didn't;
  - a local store or outbox payload has a version without a migration from the one before;
  - a store in the lock is no longer declared, and not retired;
  - a declared older version's schema differs from what the lock recorded, so an old shape was edited.

  `UPDATE_DEVICE_SCHEMAS=1` adds new versions to the lock; it never rewrites a recorded one.
- **Undeclared collections can't open.** With a registry, `Persistence` refuses to open a persisted collection the registry doesn't declare, or at another version, in tests and in the browser.
- **The fixture harness.** `src/device/fixtures/<build>.json` holds a device's stores as that deployed build wrote them: collection rows at their versions and outbox writes as the library serialized them. `src/device/migrations.test.ts` builds a real SQLite device store from each fixture, runs `device/prepare`'s work, opens every collection at this build's versions through TanStack DB, checks each row, and upgrades each outbox write. `src/device/upgrade.test.ts` opens the same device in the whole app over the real ChatApi. A deploy adds its build's fixture.
- **The fallback.** An unknown version or a failed migration keeps local rows in `device_kept`, lets synced ones resync, and records why.
- **Observability.** Every store's outcome is a log line `device.migrate` and a count of `device_migrations{store, outcome}` (`current`, `migrated`, `resync`, `kept`, `retired`, `skipped`), with `from`, `to` and the row counts; kept rows count in `device_rows_kept{store, reason}`; parked writes in `outbox_parked{name, reason}`. None carries a row's content.

## 6. Server and client compatibility

- **Two builds back.** ChatApi's routes and the shapes' column lists stay readable by the two latest deployed builds: add a column or an optional field first, start using it, and remove an old one only two deploys after nothing reads it (expand, then contract).
- **The minimum client comes from the server.** ChatApi sends `Smithers-Minimum-Epoch` with every answer. A device whose epoch is lower shows `Update` + `Reload` and sends nothing more, so a write the server can no longer read is never sent. (Slice 2.)
- **A rollback is a deploy.** Rolling back past a build that migrated a local store finds rows of a newer version: the older build keeps them in `device_kept` instead of reading them. Prefer rolling forward.

## 7. Where it lives

- **`@smthrs/effect-tanstack-db`:** `Migrations` (declarations, the registry and epoch, `apply` over any SQLite `execute`, the outbox upgrade, fingerprints and the lock check) and `Outbox.layer`'s `schema` option (stamp, upgrade, park). It runs in a browser, a Worker, Node and Bun.
- **`@smthrs/platform-browser`:** the leader's `prepare` hook and the `device/prepare` flow over its own connection to `app.db`.
- **The app** declares its stores (`src/device/`), passes `Migrations.prepare(registry)` to its engine worker and the registry to its outbox, and hands parked writes to their features.

## 8. Slice 1

Built: the declarations and the runner, `device/prepare` in the leader, the outbox's stamp, upgrade and park, the `device_kept` fallback, the lock check, and the migrations for every change since the deployed build (`7b96f878`). Tests: the fixture harness on that build's store, property tests that migrating then resyncing equals a fresh sync, a crash mid-migration that resumes, an old build's outbox write that applies after the upgrade, and the lock failing on a schema change without a version. End to end: `e2e/device-upgrade.spec.ts` opens the deployed login-only build and creates a synced row, a queued offline question and a draft. This build opens the device as the confirmed person's: the synced row is there, the queued question reaches Postgres once and the draft stays. The owner then queues a new question and saves a draft offline; both survive reopening, and nothing is sent twice. Fixture migration tests separately keep the schema-level checks for both deployed builds.

Slice 2: the epoch handshake with open tabs, the server's minimum epoch, and `device_kept` in the device's export.
