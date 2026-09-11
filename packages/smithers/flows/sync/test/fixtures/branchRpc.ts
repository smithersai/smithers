/**
 * One branch RPC client over a fresh in-memory socket pair, shared by the
 * branch suites.
 *
 * The server end runs the real schema-aware protocol (`RpcServer.make` over a
 * hand-rolled `Protocol` bound to the socket pair), so typed failures decode
 * on the client exactly as they would over a hosted transport.
 *
 * @since 0.1.0
 */
import { Effect, Layer, Option, Queue, type Scope } from "effect"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError"
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import type { FromServerEncoded } from "effect/unstable/rpc/RpcMessage"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import * as Socket from "effect/unstable/socket/Socket"
import type * as BranchCommands from "../../src/BranchCommands.ts"
import * as BranchIds from "../../src/BranchIds.ts"
import * as BranchPresence from "../../src/BranchPresence.ts"
import * as BranchRpcs from "../../src/BranchRpcs.ts"
import * as BranchServer from "../../src/BranchServer.ts"
import * as BranchShare from "../../src/BranchShare.ts"
import * as SyncPrincipal from "../../src/SyncPrincipal.ts"
import { SyncAuth } from "../../src/SyncRpcs.ts"
import type * as TestSocket from "../../src/test/TestSocket.ts"

/** The typed branch RPC client `connect` returns. */
export type Client = RpcClient.RpcClient<RpcGroup.Rpcs<typeof BranchRpcs.BranchRpcs>, RpcClientError.RpcClientError>

/** What `connect` reads from the ambient context. */
export type Requirements =
  | BranchShare.BranchShare
  | BranchPresence.BranchPresence
  | BranchCommands.BranchCommands
  | BranchIds.BranchIds
  | SyncAuth
  | Scope.Scope

/** Services the handlers use in place of the ambient ones. */
export interface Overrides {
  readonly share?: BranchShare.Service | undefined
  readonly ids?: BranchIds.Service | undefined
  readonly presence?: BranchPresence.Service | undefined
  /** The principal every request runs as, in place of the ambient `SyncAuth`. */
  readonly principal?: SyncPrincipal.Principal | undefined
}

/** Connects a branch RPC client to the handlers over `pair`. */
export const connect = (
  pair: TestSocket.Pair,
  overrides: Overrides = {}
): Effect.Effect<Client, never, Requirements> =>
  Effect.gen(function*() {
    const share = overrides.share ?? (yield* BranchShare.BranchShare)
    const ids = overrides.ids ?? (yield* BranchIds.BranchIds)
    const presence = overrides.presence ?? (yield* BranchPresence.BranchPresence)
    const auth = yield* SyncAuth
    const principal = overrides.principal
    const handlers = yield* Layer.build(BranchServer.layerHandlers).pipe(
      Effect.provideService(BranchShare.BranchShare, share),
      Effect.provideService(BranchIds.BranchIds, ids),
      Effect.provideService(BranchPresence.BranchPresence, presence)
    )
    const serialization = RpcSerialization.json.makeUnsafe()
    const writer = yield* pair.server.writer
    const protocol = yield* RpcServer.Protocol.make((writeRequest) =>
      Effect.gen(function*() {
        yield* pair.server.runRaw((bytes) =>
          Effect.forEach(serialization.decode(bytes), (message) => writeRequest(0, message as never), {
            discard: true
          })
        ).pipe(Effect.forkScoped)
        return {
          disconnects: yield* Queue.make<number>(),
          send: (_clientId: number, response: FromServerEncoded) => {
            const encoded = serialization.encode(response)
            return encoded === undefined ? Effect.void : Effect.orDie(writer(encoded))
          },
          end: () => Effect.void,
          clientIds: Effect.succeed<ReadonlySet<number>>(new Set([0])),
          initialMessage: Effect.succeed(Option.none()),
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: false,
          supportsNotifications: true,
          codecFor: RpcSerialization.json.codecFor
        }
      })
    )
    yield* RpcServer.make(BranchRpcs.BranchRpcs, { disableFatalDefects: true }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provideService(
        SyncAuth,
        principal === undefined ?
          auth :
          (effect) => Effect.provideService(effect, SyncPrincipal.SyncPrincipal, principal)
      ),
      Effect.provide(handlers),
      Effect.forkScoped
    )
    const clientProtocol = yield* RpcClient.makeProtocolSocket().pipe(
      Effect.provideService(Socket.Socket, pair.client),
      Effect.provide(RpcSerialization.layerJson)
    )
    return yield* RpcClient.make(BranchRpcs.BranchRpcs).pipe(
      Effect.provideService(RpcClient.Protocol, clientProtocol)
    )
  })
