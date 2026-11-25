import { CauseReceipt, Core, type Principal } from "@smthrs/app-core"
import {
  canonicalHash,
  decidePlan,
  emptyPlanTree,
  evolvePlan,
  PlanCommand,
  PlanEvent,
  PlanTree
} from "@smthrs/app-state"
import { DoSqliteShard, type ObjectDatabase } from "@smthrs/platform-cloudflare"
import { ShardClient, ShardProtocol } from "@smthrs/sync"
import { Effect, Schema, Semaphore } from "effect"

export const update = "plan/update"
export const review = "plan/review"
export const read = "plan/tree"

export const readCapability = (shard: ShardProtocol.ShardId) => "plan:read:" + shard
export const writeCapability = (shard: ShardProtocol.ShardId) => "plan:write:" + shard

const Recorded = Schema.Struct({ event: PlanEvent, cause: CauseReceipt.CauseReceipt })
const Snapshot = Schema.Struct({ tree: PlanTree, receipts: Schema.Array(CauseReceipt.CauseReceipt) })
const decodeSnapshot = Schema.decodeUnknownSync(Snapshot)
const decodeEvent = Schema.decodeUnknownSync(Recorded)
const decodeCommand = Schema.decodeUnknownOption(PlanCommand)

export const apply = (tree: PlanTree, delivery: ShardClient.Delivery): PlanTree => {
  if (delivery._tag === "Reset") {
    return delivery.snapshot.state === null ? emptyPlanTree : decodeSnapshot(delivery.snapshot.state).tree
  }
  return delivery.entries.reduce<PlanTree>(
    (state, entry) => entry.events.reduce<PlanTree>((current, event) => evolvePlan(current, decodeEvent(event).event), state),
    tree
  )
}

export const make = Effect.fnUntraced(function*(
  storage: ObjectDatabase.Storage,
  shard: ShardProtocol.ShardId,
  credentials: Principal.Credentials
) {
  const { shard: journal } = yield* DoSqliteShard.make(storage, { shard })
  const snapshot = yield* journal.snapshot(shard)
  let tree = apply(emptyPlanTree, { _tag: "Reset", snapshot })
  let receipts = snapshot.state === null ? [] : [...decodeSnapshot(snapshot.state).receipts]
  const reader = yield* ShardClient.make({
    shard,
    node: "authority",
    transport: journal,
    store: ShardClient.memoryStore(),
    apply: (delivery) => Effect.sync(() => {
      tree = apply(tree, delivery)
      if (delivery._tag === "Reset") {
        receipts = delivery.snapshot.state === null ? [] : [...decodeSnapshot(delivery.snapshot.state).receipts]
      } else {
        for (const entry of delivery.entries) {
          for (const event of entry.events) receipts.push(decodeEvent(event).cause)
        }
      }
    })
  })
  // Rebuild the reducer from the durable snapshot and tail before admitting requests.
  const head = yield* reader.pull
  const lock = yield* Semaphore.make(1)
  const payload = {
    type: "object",
    properties: { command: { type: "object", properties: {}, additionalProperties: true } },
    required: ["command"],
    additionalProperties: false
  } as const
  const flow = (tag: typeof update | typeof review): Core.Flow => ({
    tag,
    title: tag === review ? "Review plan" : "Update plan",
    payload,
    capabilities: [writeCapability(shard)],
    ...(tag === review ? { personOnly: "Only the person can finish a plan node." } : {}),
    run: (input, tx) => {
      const command = decodeCommand(input["command"])
      if (command._tag === "None") return new Core.Failed("invalid_command", "Invalid plan command.")
      const value = command.value
      const finishing = value._tag === "SetNodeStatus" && value.status === "done"
      if (finishing !== (tag === review)) return new Core.Failed("wrong_operation", "Use the matching plan operation.")
      const result = decidePlan(tree, value)
      if (result._tag === "Refused") return new Core.Failed("invalid_command", JSON.stringify(result))
      const nodeId = "id" in value ? value.id : value.nodeId
      tx.causedBy({ page: shard, blockId: nodeId, rev: String(tree.revision) })
      const event = result.events[0]
      if (event === undefined || result.events.length !== 1) {
        return new Core.Failed("invalid_event_count", "The plan must produce one event.")
      }
      tx.put("plan", "tree", evolvePlan(tree, event))
      return event
    }
  })
  const stream = Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard)
  const engine = yield* Core.make({
    credentials,
    initialJournalSeq: head.seq,
    causeCapabilities: [readCapability(shard)],
    initialRows: [{ collection: "plan", key: "tree", row: tree }],
    initialReceipts: receipts.map((receipt) => ({ receipt })),
    flows: [flow(update), flow(review)],
    projections: [{ name: read, title: "Plan tree", collection: "plan", capabilities: [readCapability(shard)] }],
    persist: (requested) => lock.withPermit(Effect.gen(function*() {
      const event = Schema.decodeUnknownSync(PlanEvent)(requested.output)
      const current = yield* journal.head
      const commit = yield* journal.submit({
        version: 2,
        shard,
        epoch: current.epoch,
        command: {
          key: ["plan", requested.runId],
          stream,
          payload: { event, cause: requested.cause }
        }
      }).pipe(Effect.orDie)
      if (commit._tag !== "Accepted") return yield* Effect.die(new Error("Plan journal refused its own commit"))
      tree = evolvePlan(tree, event)
      receipts.push(requested.cause)
    }))
  })
  return {
    shard,
    engine,
    canRead: (evidence: Principal.McpEvidence) => Effect.map(
      credentials.mint(evidence),
      (principal) => credentials.authority(principal)?.capabilities.includes(readCapability(shard)) === true
    ),
    journal: { pull: journal.pull, snapshot: journal.snapshot },
    state: Effect.sync(() => ({ tree, hash: canonicalHash(tree) })),
    compact: lock.withPermit(Effect.flatMap(journal.head, ({ seq }) => journal.compact(seq, { tree, receipts })))
  }
})

export type LivePlanTree = Effect.Success<ReturnType<typeof make>>
