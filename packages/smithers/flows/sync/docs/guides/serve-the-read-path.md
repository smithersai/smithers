---
title: "Serve the read path"
description: "Compose SyncServer over a journal and a run catalog, mount the RPC group on a transport with its authentication middleware, and set the policy that bounds one follower's cost."
sidebar:
  order: 2
---

This guide builds the serving side. A host that already runs
[`@smthrs/gateway`](/api/gateway) has this done: the gateway mounts `SyncRpcs`
on `POST /sync` and `/sync/ws`. Build it yourself when you are embedding the
read path in a host of your own.

## Compose the server

`SyncServer.layer` requires a `Journal` and a `RunCatalog`, and nothing else:

```ts
import * as RunCatalog from "@smthrs/sync/RunCatalog"
import * as SyncServer from "@smthrs/sync/SyncServer"
import * as Layer from "effect/Layer"

const serverLayer = SyncServer.layer.pipe(
  Layer.provide(RunCatalog.layerStatic([]))
)
```

The journal is still required, and the composition supplies it: in production
that is `@smthrs/journal`'s `SqlJournal` over
[`@smthrs/database`](/api/database). The catalog is the workspace's run set;
`layerStatic([])` serves a workspace with no runs, which is what a run-scoped
deployment wants. For a catalog that learns of runs another engine created, see
[List a workspace's runs](./list-workspace-runs.md).

Provide `BranchShare` as well if any run in the workspace is a shared branch.
Without it in scope, every branch run is closed.

## Mount the RPC group

`SyncServer.layerHandlers` projects the service onto the wire. It is a thin
projection with no policy of its own, so the handlers and an in-process caller
face the same rules:

```ts
import { SyncRpcs } from "@smthrs/sync/SyncRpcs"
import * as RpcServer from "effect/rpc/RpcServer"

const mount = RpcServer.layer(SyncRpcs, { disableFatalDefects: true }).pipe(
  Layer.provide(SyncServer.layerHandlers),
  Layer.provideMerge(RpcServer.layerProtocolHttp({ path: "/sync" }))
)
```

Mount both protocols against the same handlers when clients read a page over
the request path and follow over a socket. Pointing them at two servers would
let the two halves disagree.

## Supply the authentication middleware

`SyncRpcs` is bound to the `SyncAuth` middleware tag, so serving it requires an
implementation. The production one verifies the capability header:

```ts
import * as SyncAuth from "@smthrs/sync/SyncAuth"
import * as WorkspaceShare from "@smthrs/sync/WorkspaceShare"

const authorized = SyncAuth.layer.pipe(Layer.provide(WorkspaceShare.layerConfig))
```

Without a middleware-installed principal every request runs as anonymous and
every non-branch read is refused. That is the fail-closed default, not a
misconfiguration to work around. See
[Authorize a connection](./authorize-a-connection.md) for minting and rotation,
and [Authorization](../concepts/authorization.md) for why the two boundaries
are shaped this way.

## Read in process, without a transport

A caller that already owns the journal skips the wire and provides the
principal directly:

```ts
import * as SyncPrincipal from "@smthrs/sync/SyncPrincipal"
import * as Effect from "effect/Effect"

const page = Effect.gen(function*() {
  const server = yield* SyncServer.SyncServer
  return yield* server.read({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], limit: 100 })
}).pipe(Effect.provide(SyncPrincipal.layerWorkspace("host")))
```

That is the only sanctioned bypass of the header check, and it is never a
transport's to take. An in-process owner presented no credential, so nothing
can expire under it and its subscriptions have no deadline.

## Set the policy

`SyncServer.layerWith` takes the read-path policy. Every field defaults, and
every field is validated as a positive safe integer at construction, so a bad
value fails loudly instead of quietly disabling the bound it configures:

```ts
const tuned = SyncServer.layerWith({
  maxFrameBytes: 512 * 1024,
  concurrency: 32,
  tailIntervalMs: 250
})
```

| Option           | Default | What it bounds                                                                                         |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `maxFrameBytes`  | 2 MiB   | Summed encoded entries of one read page or subscription frame.                                         |
| `concurrency`    | 64      | Journal reads one workspace subscription holds open at once.                                           |
| `tailIntervalMs` | 1000    | Milliseconds a workspace subscription waits before revisiting every covered run when nothing wakes it. |

`concurrency` bounds what one follower costs without bounding what it sees: the
workspace tail visits every covered run each round, so a run past the bound
waits one round for a slot rather than being starved.

`tailIntervalMs` is the freshness policy for runs another process owns, not for
runs written beside the follower. An entry this process commits is published on
`Journal.changes` and wakes the round at once. A run-scoped subscription follows
one journal stream directly and keeps that stream's wake.

## What the server refuses

- A request whose cursor set names one run twice, with `invalid_request`.
- A single entry whose own encoded size exceeds `maxFrameBytes`. A run-scoped
  read or subscription fails with `frame_too_large`. A workspace read or
  subscription withholds that one run below the entry, keeps serving the other
  runs, and logs a warning naming the run, the sequence and the size. A page
  that merely sums past the ceiling is truncated and reports `done: false`
  instead.

The journal refuses such an entry at the write: `SqlJournal`'s `maxEntryBytes`
defaults to 2 MiB less 64 KiB, so every entry it admits fits a default frame.
If you raise `maxFrameBytes`, raise `maxEntryBytes` with it. The withheld-run
path is for rows written before that bound, or under a larger one.

- Every non-branch read for an anonymous caller, with `unauthorized`.
- A subscription whose credential has expired, which ends the stream with
  `unauthorized`.

A journal failure crosses as its stable journal code with a constant public
message. The driver's own sentence stays on the server, because a follower may
hold nothing but a share link and a SQLite message routinely carries SQL text,
table names, and constraint identifiers.

## Related pages

- [List a workspace's runs](./list-workspace-runs.md): the catalog this server
  reconciles against.
- [Authorize a connection](./authorize-a-connection.md): the credential the
  middleware verifies.
- [Test a follower](./test-a-follower.md): a real server and client over an
  in-memory socket.
