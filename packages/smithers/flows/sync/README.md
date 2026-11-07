# @smthrs/sync

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact `4.1.1` peer dependency. Install one
`effect` release at that version so all Smithers packages share one Effect
runtime.

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/sync/docs

Browser-safe, read-only replication of canonical
[`@smthrs/journal`](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/journal/docs) entries. It defines the wire
protocol, the RPC group, the server, and the replay-then-follow client.

The read path, `SyncRpcs` served by `SyncServer` and followed by `SyncClient`,
never writes to a journal, so a follower cannot corrupt what it reads.
`BranchCommands` is the separate write surface: it appends admitted branch
commands to a branch's journal run after verifying a write-scoped
`BranchShare` capability.

## Install

```bash
npm install @smthrs/sync@next effect
```

`effect` is a peer dependency at exactly `4.1.1`. Two copies of `effect`
in one program are two sets of service tags, so a client built against one copy
cannot be provided to a program holding the other.

Node.js 22.19.0 or later, or a browser with Web Crypto. The package ships as
both ESM and CommonJS with TypeScript declarations.

## Follow a run

One `subscribe` call replays a run's durable history and then follows it live,
through a single stream:

```ts
import type { JournalEvent } from "@smthrs/journal"
import * as SyncClient from "@smthrs/sync/SyncClient"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as Stream from "effect/Stream"

const runId = "build-42" as JournalEvent.RunId

export const follow = Effect.gen(function*() {
  const sync = yield* SyncClient.SyncClient
  yield* sync.subscribe({ scope: { _tag: "Run", runId }, cursors: [] }).pipe(
    Stream.runForEach((entry) => Effect.logInfo(`${entry.seq} ${entry.eventType}`))
  )
})

export const clientLayer = SyncClient.layer.pipe(
  Layer.provide(RpcClient.layerProtocolSocket()),
  Layer.provide(RpcSerialization.layerJson)
)
```

The socket that protocol runs over comes from your platform: a WebSocket in a
browser, `@effect/platform-node`'s socket layer in Node. Pass
`{ _tag: "Workspace" }` instead of a run scope to follow every run the server
lists and your credential covers.

The serving side is `SyncServer` over a journal and a run catalog.
[`@smthrs/gateway`](https://github.com/smithersai/smithers/tree/main/packages/smithers/gateway/docs) already mounts it on
`POST /sync` and `/sync/ws`, so a follower against a Smithers gateway writes
only the code above.

`Read` pages durable entries, then the client subscribes from exclusive per-run
cursors. A non-contiguous journal sequence is valid; `SyncGapError` means the
server skipped beyond the interval covered by the client's cursor.

`sync.progress` reports two cursor sets: `delivered` holds delivery bookmarks,
and `applied` holds what successful `apply` or `onResync` callbacks
acknowledged. Those callbacks fail with your own error types, which the
subscription's error channel carries unchanged. Persist state and its cursor
together inside those callbacks. An applying subscriber never skips entries
merely because an earlier subscriber received them.

## Authorization

Authorization is fail-closed along two boundaries, and both are consulted on
every request. Branch runs authorize through the branch share capability
carried in each request (`BranchShare`); a share link grants exactly its
branch's run. Non-branch runs and workspace listings authorize through the
authenticated workspace principal (`SyncPrincipal`, default anonymous), which
`SyncAuth.layer` establishes over RPC by verifying the `WorkspaceShare`
capability presented in the `flows-sync-workspace` request header. A connection
with no valid credential is refused every non-branch read.

Both authorities take `Redacted` keyrings, lead their signed encoding with a
scheme label, and carry a rotation-ready `kid` inside the signed claims. An
open subscription ends with `unauthorized` when the credential that opened it
expires, because a stream authorized once at open is otherwise the one thing a
signed expiry cannot revoke. See
[Authorization](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/docs/concepts/authorization.md).

## Branch collaboration

A branch is one shared live document whose durable state is exactly one journal
run (`BranchProtocol.branchRunId`), so multiplayer reuses the canonical `seq`,
cursors, gap detection, and resumable follow rather than introducing a second
source of truth. Presence is a lease and is never journalled; commands are
admitted through a client-minted idempotency key; every branch operation after
`Branch.CreateBranch` authorizes through a signed, expiring, branch-scoped
share capability.

The native gateway mounts the existing branch presence RPCs at `POST /branch`
when its authenticated runtime bridge is configured. The Go install resolves
membership, branch and socket session before forwarding; this host adapter uses
the same `BranchPresence` lease roster. Branch commands and share-link bootstrap
remain unserved on that mount. See
[Branch collaboration](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/docs/concepts/branches.md).

## Bounds

Every in-flight surface is bounded: entries per page, frames per subscription,
journal reads open per workspace subscription, bytes per frame. What one
follower holds open is a function of the configured bound, not of how far
behind it has fallen. Bookkeeping and periodic work still scale with the
workspace: a workspace subscription keeps a position for every run it has
covered, and its catalog-wide round, once per `tailIntervalMs` or on an
announcement, reads one page per listed run under the concurrency bound. A
wake for a local append reads only the run it named. Every numeric option is
validated where it enters: a value that is not a positive safe integer fails
the constructor with `invalid_request` rather than quietly disabling the
comparison it configures.
The table of bounds and defaults is in the
[API reference](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/docs/api.md#bounds).

Both change feeds slide rather than block, and neither is a source of truth.
`RunCatalog.list` and `BranchPresence.list` are the authoritative state, and
every reader re-lists on a cadence of its own, so a dropped notification costs
latency and never state.

## Rewinds and cursor generations

`RunCursor` and `EntriesFrame` carry a `generation`. Server responses always
include it, zero included, and a client refuses one that omits it; a persisted
request cursor may omit it for generation zero. SQL journals persist it
independently of sequence numbers. Rewind increments it atomically with
truncation, so a follower at 100 cannot silently discard a replacement entry at
51 after rewinding to 50.

Both reads and subscriptions fail with `SyncError.code = "lineage_changed"`
when generations differ. Live run and workspace subscriptions also check while
idle, within `tailIntervalMs`. This failure is terminal: rebuild the projection
from the current retained history through the archive boundary, create a fresh
sync client, and resume from the server error's
`rewind: { runId, generation, afterSeq }`. For `afterSeq: -1`, omit the cursor
to replay the entire current history. Keep the generation with every persisted
cursor. Compaction recovery remains separate.

Append-only journal adapters may omit `Journal.Service.generation`. Any adapter
that truncates or replaces history must implement it and advance the generation
in its truncation transaction. Upgrade sync clients and servers together;
older clients cannot detect generation changes. See
[Rewind generations](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/docs/api.md#rewind-generations).

## Public API

The root exports these namespaces, also available from matching
`@smthrs/sync/*` subpaths. The
[API reference](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/docs/api.md) documents
each one.

| Namespace          | What it owns                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `SyncError`        | `ErrorCode`, `SyncError` with the structural guard `SyncError.is`, and terminal `SyncGapError`.                 |
| `SyncProtocol`     | Scopes, cursors, `Resync`, request and response schemas, frames, and the size and request limits.               |
| `SyncRpcs`         | The read-path RPC group (`Sync.Read`, `Sync.Subscribe`, `Sync.Snapshot`) and the `SyncAuth` middleware service. |
| `SyncAuth`         | Implementations of that middleware: `layer`, `layerClient`, and the header codec.                               |
| `SyncPrincipal`    | The per-request identity reference, its constructors, and `layerWorkspace` for in-process owners.               |
| `WorkspaceShare`   | The workspace capability authority over a `Redacted` keyring with `kid` rotation.                               |
| `RunCatalog`       | The workspace run set a subscription reconciles against, in-memory, polling, and static forms.                  |
| `SyncServer`       | The read-path implementation, its policy, and `layerHandlers`.                                                  |
| `SyncClient`       | The browser-safe replay-then-follow client and its subscription options.                                        |
| `BranchProtocol`   | The branch vocabulary: ids, claims, capabilities, submissions, receipts, and the run-id mapping.                |
| `BranchShare`      | The branch capability authority over a `Redacted` keyring with `kid` rotation.                                  |
| `BranchIds`        | The port branch and capability ids are minted through.                                                          |
| `BranchCommands`   | Idempotent command admission onto a branch's journal run.                                                       |
| `BranchPresence`   | The ephemeral, lease-expiring roster.                                                                           |
| `BranchProjection` | The fold from branch commands to a document view.                                                               |
| `BranchRpcs`       | The branch collaboration wire group.                                                                            |
| `BranchServer`     | The handler layer that projects the branch services onto that group.                                            |
| `PresenceProtocol` | The presence wire: state and roster frames, limits, close codes, and the reconnect backoff.                     |
| `PresenceRoom`     | The host side of a presence room, kept entirely in its sockets' attachments.                                    |
| `PresenceSocket`   | The page's reconnecting socket to a presence room.                                                              |

Public test subpaths are `@smthrs/sync/test/TestSocket` (`FrameFilter`,
`TestFaults`, `Pair`, `makePair`) and `@smthrs/sync/test/TestSync`
(`layerTest`, `layerTrustAllAsOwner`, `layerNoop`, `connect`).

## Documentation

- [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/docs/installation.md)
- [Quickstart](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/docs/quickstart.md)
- [Scopes and cursors](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/docs/concepts/scopes-and-cursors.md)
- [Replay then follow](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/docs/concepts/replay-then-follow.md)
- [Authorization](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/docs/concepts/authorization.md)
- [Presence rooms](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/docs/concepts/presence.md)
- [Follow a run](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/docs/guides/follow-a-run.md)
- [Serve the read path](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/docs/guides/serve-the-read-path.md)
- [Wire protocol](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/docs/protocol.md)
- [API reference](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/docs/api.md)
- [Troubleshooting](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/sync/docs/troubleshooting.md)
- [Optional long soak](docs/guides/run-a-long-soak.md)

## License

MIT
