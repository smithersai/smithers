/**
 * The TypeScript twin of `Oracle.runOp` in `lean/smithers-state/Main.lean`.
 * Both sides run the same ops, emit the same result codes, and fold the same
 * canonical JSON into the same FNV-1a 32-bit digest.
 */
import {
  applyCommit,
  bumpEpoch,
  canonicalJson,
  type Command,
  initialReplica,
  initialShardState,
  installSnapshot,
  rebasePending,
  type Replica,
  type ShardState,
  submit
} from "../src/index.ts"

export type Op =
  | {
    readonly op: "submit"
    readonly epoch: number
    readonly origin: string
    readonly commandId: string
    readonly command: Command
  }
  | { readonly op: "bumpEpoch" }
  | { readonly op: "deliver"; readonly replica: number; readonly from: number; readonly count: number }
  | { readonly op: "resync"; readonly replica: number }
  | { readonly op: "rebase"; readonly replica: number; readonly pending: ReadonlyArray<Command> }

export interface World {
  readonly hub: ShardState
  readonly replicas: ReadonlyArray<Replica>
}

export const initialWorld = (replicas: number): World => ({
  hub: initialShardState,
  replicas: Array.from({ length: replicas }, () => initialReplica)
})

const encoder = new TextEncoder()

export const FNV_INIT = 2166136261

export const fnv = (seed: number, text: string): number => {
  let h = seed
  for (const byte of encoder.encode(text)) h = Math.imul(h ^ byte, 16777619)
  return h >>> 0
}

const APPLY_CODE = { Applied: "a", Duplicate: "d", Gap: "g", StaleEpoch: "s", EpochAhead: "h" } as const

export interface Ran {
  readonly world: World
  readonly code: string
  /** The state the op touched; its canonical JSON feeds the digest. */
  readonly touched: unknown
}

const replicaAt = (world: World, index: number): Replica => {
  const replica = world.replicas[index]
  if (replica === undefined) throw new Error(`no replica ${index}`)
  return replica
}

const withReplica = (world: World, index: number, replica: Replica): World => ({
  hub: world.hub,
  replicas: world.replicas.map((current, i) => (i === index ? replica : current))
})

export const runOp = (world: World, op: Op): Ran => {
  switch (op.op) {
    case "submit": {
      const { result, state } = submit(world.hub, {
        epoch: op.epoch,
        origin: op.origin,
        commandId: op.commandId,
        command: op.command
      })
      const code = result._tag === "Accepted"
        ? `A:${result.firstSeq}:${result.count}`
        : result._tag === "Duplicate"
        ? `D:${result.firstSeq}:${result.count}`
        : result._tag === "Refused"
        ? `R:${result.reason}`
        : `E:${result.current}`
      return { world: { hub: state, replicas: world.replicas }, code, touched: state }
    }
    case "bumpEpoch": {
      const hub = bumpEpoch(world.hub)
      return { world: { hub, replicas: world.replicas }, code: `B:${hub.epoch}`, touched: hub }
    }
    case "deliver": {
      let replica = replicaAt(world, op.replica)
      let codes = ""
      for (const commit of world.hub.log.slice(op.from, op.from + op.count)) {
        const applied = applyCommit(replica, commit)
        replica = applied.replica
        codes += APPLY_CODE[applied.result]
      }
      return { world: withReplica(world, op.replica, replica), code: `V:${codes}`, touched: replica }
    }
    case "resync": {
      const replica = installSnapshot(
        replicaAt(world, op.replica),
        world.hub.epoch,
        world.hub.headSeq,
        world.hub.state
      )
      return {
        world: withReplica(world, op.replica, replica),
        code: `S:${replica.epoch}:${replica.cursor}`,
        touched: replica
      }
    }
    case "rebase": {
      const rebased = rebasePending(replicaAt(world, op.replica).confirmed, op.pending)
      const codes = rebased.decisions.map((decision) =>
        decision._tag === "Accepted" ? `a${decision.events.length}` : `r:${decision.reason}`
      )
      return { world, code: `P:${codes.join(",")}`, touched: rebased.state }
    }
  }
}

export const foldDigest = (digest: number, ran: Ran): number => fnv(fnv(digest, ran.code), canonicalJson(ran.touched))
