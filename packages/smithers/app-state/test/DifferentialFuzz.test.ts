/**
 * Differential fuzz: 500 seeded traces of commands and faults.
 *
 * Each trace drives one shard authority and three replicas through request
 * drops, response drops, duplicate and reordered deliveries, skipped pages,
 * stale generations, cycle-creating moves, and concurrent edits. The TypeScript
 * machine checks its own invariants at every step. The same traces, run through
 * the compiled Lean oracle on nyc-02, produced `fixtures/lean-oracle-receipt.jsonl`;
 * the last test demands 100% agreement with it.
 *
 * Regenerate the fixture after any change to the machine or the generator:
 *   APP_STATE_WRITE_TRACES=/tmp/app-state-traces.jsonl vitest run test/DifferentialFuzz.test.ts
 *   lake build && .lake/build/bin/oracle < traces.jsonl > lean-oracle-receipt.jsonl   (in lean/smithers-state)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  type AppState,
  canonicalHash,
  canonicalJson,
  type Command,
  evolve,
  initialAppState,
  type PlanTree,
  rebasePending,
  type ShardState,
  walk
} from "../src/index.ts"
import { FNV_INIT, fnv, foldDigest, initialWorld, type Op, runOp, type World } from "./harness.ts"

const TRACES = 500
const STEPS = 36
const REPLICAS = 3
const FIXTURE = fileURLToPath(new URL("fixtures/lean-oracle-receipt.jsonl", import.meta.url))

const mulberry32 = (seed: number) => {
  let a = seed >>> 0
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Stats {
  accepted: number
  duplicateSubmits: number
  cycleRefusals: number
  revisionConflicts: number
  idempotencyConflicts: number
  messageConflicts: number
  staleGenerationSubmits: number
  requestDrops: number
  responseDrops: number
  duplicateDeliveries: number
  gapDeliveries: number
  staleCommits: number
  epochAheadCommits: number
  resyncs: number
  hubRestarts: number
  duplicateRows: number
}

const emptyStats = (): Stats => ({
  accepted: 0,
  duplicateSubmits: 0,
  cycleRefusals: 0,
  revisionConflicts: 0,
  idempotencyConflicts: 0,
  messageConflicts: 0,
  staleGenerationSubmits: 0,
  requestDrops: 0,
  responseDrops: 0,
  duplicateDeliveries: 0,
  gapDeliveries: 0,
  staleCommits: 0,
  epochAheadCommits: 0,
  resyncs: 0,
  hubRestarts: 0,
  duplicateRows: 0
})

/** Independent of `decide`: dangling parents and cycles, found by plain graph search. */
const treeViolations = (tree: PlanTree): ReadonlyArray<string> => {
  const violations: Array<string> = []
  for (const [key, node] of Object.entries(tree.nodes)) {
    if (node.id !== key) violations.push(`key ${key} holds node ${node.id}`)
    if (node.parent !== null && !Object.hasOwn(tree.nodes, node.parent)) {
      violations.push(`${key} points at missing parent ${node.parent}`)
    }
    const seen = new Set<string>([key])
    let current = node.parent
    while (current !== null && Object.hasOwn(tree.nodes, current)) {
      if (seen.has(current)) {
        violations.push(`cycle through ${current}`)
        break
      }
      seen.add(current)
      current = tree.nodes[current]!.parent
    }
  }
  return violations
}

const replay = (shard: ShardState, upTo: number): AppState => shard.log.slice(0, upTo).reduce(evolve, initialAppState)

const NODE_IDS = ["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7"] as const
const TITLES = ["sync engine", "plan tree", "chat pane", "lean proof", "fuzz"] as const
const MILESTONES = ["M0", "M1", "M2", "M3"] as const
const NODE_STATUSES = ["pending", "in_progress", "blocked_on_will", "done", "failed"] as const
const MESSAGE_STATUSES = ["posted", "streaming", "complete", "failed"] as const
const ASSUMPTIONS = ["hub is sole sequencer", "sqlite wal on", "epoch is monotonic"] as const

interface Pending {
  readonly commandId: string
  readonly command: Command
}

interface Trace {
  readonly seed: number
  readonly line: string
  readonly results: ReadonlyArray<string>
  readonly digest: number
  readonly world: World
  readonly stats: Stats
}

const simulate = (seed: number): Trace => {
  const rng = mulberry32(seed)
  const int = (n: number): number => Math.floor(rng() * n)
  const pick = <A>(items: ReadonlyArray<A>): A => items[int(items.length)]!
  const stats = emptyStats()
  const ops: Array<Op> = []
  const results: Array<string> = []
  let world = initialWorld(REPLICAS)
  let digest = FNV_INIT
  const pending: Array<Array<Pending>> = Array.from({ length: REPLICAS }, () => [])
  const needsResync: Array<boolean> = Array.from({ length: REPLICAS }, () => false)
  const sent: Array<{ readonly origin: string; readonly commandId: string; readonly command: Command }> = []
  const firstAnswer = new Map<string, string>()
  let commandCounter = 0
  let messageCounter = 0
  let bumps = 0

  const fail = (message: string): never => {
    throw new Error(`seed ${seed} op ${ops.length}: ${message}`)
  }

  const checkHub = (): void => {
    const hub = world.hub
    hub.log.forEach((commit, index) => {
      if (commit.hubSeq !== index + 1) fail(`log not gapless at ${index}`)
    })
    if (hub.headSeq !== hub.log.length) fail("headSeq differs from log length")
    const violations = treeViolations(hub.state.plan)
    if (violations.length > 0) fail(violations.join("; "))
    const ids = hub.state.chat.messages.map((message) => message.id)
    stats.duplicateRows += ids.length - new Set(ids).size
    const seqs = hub.state.chat.messages.map((message) => message.hubSeq)
    if (seqs.some((seq, index) => seq <= (seqs[index - 1] ?? 0))) fail("messages out of hubSeq order")
    if (canonicalJson(replay(hub, hub.headSeq)) !== canonicalJson(hub.state)) fail("hub state differs from log replay")
  }

  const checkReplica = (index: number): void => {
    const replica = world.replicas[index]!
    if (replica.cursor > world.hub.headSeq) fail(`replica ${index} is ahead of the hub`)
    if (canonicalJson(replica.confirmed) !== canonicalJson(replay(world.hub, replica.cursor))) {
      fail(`replica ${index} diverged from the log prefix at cursor ${replica.cursor}`)
    }
    const violations = treeViolations(replica.confirmed.plan)
    if (violations.length > 0) fail(violations.join("; "))
  }

  const exec = (op: Op): string => {
    const before = world.hub
    const ran = runOp(world, op)
    ops.push(op)
    results.push(ran.code)
    digest = foldDigest(digest, ran)
    world = ran.world
    const kind = ran.code[0]
    if (op.op === "submit") {
      const key = `${op.origin}/${op.commandId}`
      if (kind === "A") {
        stats.accepted++
        if (firstAnswer.has(key)) fail(`command ${key} was accepted twice`)
        firstAnswer.set(key, ran.code.slice(1))
        if (Object.keys(world.hub.receipts).length !== stats.accepted) fail("receipt count differs from accepted count")
      } else {
        if (world.hub !== before) fail(`${ran.code} changed the shard`)
        if (kind === "D") {
          stats.duplicateSubmits++
          if (firstAnswer.get(key) !== ran.code.slice(1)) fail(`duplicate answer ${ran.code} differs from the original`)
        } else if (kind === "E") stats.staleGenerationSubmits++
        else if (ran.code === "R:cycle") stats.cycleRefusals++
        else if (ran.code === "R:revision_mismatch") stats.revisionConflicts++
        else if (ran.code === "R:idempotency_conflict") stats.idempotencyConflicts++
        else if (ran.code === "R:message_conflict") stats.messageConflicts++
      }
      checkHub()
    } else if (op.op === "deliver") {
      const delivered = before.log.slice(op.from, op.from + op.count)
      const mine = `r${op.replica}`
      ran.code.slice(2).split("").forEach((code, index) => {
        if (code === "d") stats.duplicateDeliveries++
        else if (code === "g") stats.gapDeliveries++
        else if (code === "s") stats.staleCommits++
        else if (code === "h") {
          stats.epochAheadCommits++
          needsResync[op.replica] = true
        } else {
          const commit = delivered[index]!
          if (commit.origin === mine) {
            pending[op.replica] = pending[op.replica]!.filter((entry) => entry.commandId !== commit.commandId)
          }
        }
      })
      checkReplica(op.replica)
    } else if (op.op === "resync") {
      stats.resyncs++
      needsResync[op.replica] = false
      checkReplica(op.replica)
    }
    return ran.code
  }

  const expected = (view: AppState): number | null => (rng() < 0.4 ? view.plan.revision : null)

  const upsertCommand = (view: AppState): Command => {
    const id = pick(NODE_IDS)
    const existing = Object.hasOwn(view.plan.nodes, id) ? view.plan.nodes[id] : undefined
    const known = Object.keys(view.plan.nodes)
    const parent = existing !== undefined && rng() < 0.9
      ? existing.parent
      : rng() < 0.1
      ? pick(NODE_IDS)
      : known.length > 0 && rng() < 0.75
      ? pick(known)
      : null
    return {
      _tag: "UpsertPlanNode",
      id,
      parent,
      title: pick(TITLES),
      milestone: pick(MILESTONES),
      sources: rng() < 0.5 ? ["gate-1"] : [],
      assumptions: ASSUMPTIONS.slice(0, int(4)),
      dodFast: "pnpm test",
      order: int(4),
      expectedRevision: expected(view)
    }
  }

  const command = (view: AppState, origin: string): Command => {
    const known = Object.keys(view.plan.nodes)
    const node = (): string => (known.length > 0 && rng() < 0.92 ? pick(known) : pick(NODE_IDS))
    const roll = rng()
    if (roll < 0.28 || known.length === 0 && roll < 0.7) return upsertCommand(view)
    if (roll < 0.5) {
      const id = node()
      const below = known.filter((other) => walk(view.plan, id, known.length + 1, other) === true)
      const newParent = below.length > 0 && rng() < 0.35 ? pick(below) : rng() < 0.15 ? null : node()
      return { _tag: "MovePlanNode", id, newParent, order: int(4), expectedRevision: expected(view) }
    }
    if (roll < 0.58) return { _tag: "ToggleAssumption", nodeId: node(), index: int(3), expectedRevision: expected(view) }
    if (roll < 0.66) {
      return { _tag: "SetNodeStatus", nodeId: node(), status: pick(NODE_STATUSES), expectedRevision: expected(view) }
    }
    if (roll < 0.73) {
      return { _tag: "AttachArtifact", nodeId: node(), artifactId: `art${int(3)}`, expectedRevision: expected(view) }
    }
    if (roll < 0.9) {
      const shared = rng() < 0.25
      return {
        _tag: "PostMessage",
        messageId: shared ? `shared${int(3)}` : `m-${origin}-${messageCounter++}`,
        author: shared ? "team" : origin,
        body: shared ? pick(["ack", "nack"]) : pick(TITLES)
      }
    }
    const messages = view.chat.messages
    return {
      _tag: "UpdateMessageStatus",
      messageId: messages.length > 0 && rng() < 0.9 ? pick(messages).id : "m-missing",
      status: pick(MESSAGE_STATUSES)
    }
  }

  const create = (index: number): void => {
    const queue = pending[index]!
    exec({ op: "rebase", replica: index, pending: queue.map((entry) => entry.command) })
    const view = rebasePending(world.replicas[index]!.confirmed, queue.map((entry) => entry.command)).state
    queue.push({ commandId: `c${commandCounter++}`, command: command(view, `r${index}`) })
  }

  const push = (index: number): void => {
    const entry = pending[index]![0]
    if (entry === undefined) return create(index)
    if (rng() < 0.12) {
      stats.requestDrops++
      return
    }
    const origin = `r${index}`
    const code = exec({
      op: "submit",
      epoch: world.replicas[index]!.epoch,
      origin,
      commandId: entry.commandId,
      command: entry.command
    })
    sent.push({ origin, commandId: entry.commandId, command: entry.command })
    if (rng() < 0.12) {
      stats.responseDrops++
      return
    }
    if (code.startsWith("E")) needsResync[index] = true
    else pending[index] = pending[index]!.filter((other) => other.commandId !== entry.commandId)
  }

  const redeliver = (): void => {
    if (sent.length === 0) return
    const original = pick(sent)
    const roll = rng()
    const epoch = roll < 0.2 && world.hub.epoch > 0 ? world.hub.epoch - 1 : world.hub.epoch
    const mutated: Command = roll > 0.75
      ? { _tag: "PostMessage", messageId: `mut-${original.commandId}`, author: original.origin, body: "mutated" }
      : original.command
    exec({ op: "submit", epoch, origin: original.origin, commandId: original.commandId, command: mutated })
  }

  const sync = (index: number): void => {
    if (needsResync[index] === true && rng() < 0.7) exec({ op: "resync", replica: index })
    const cursor = world.replicas[index]!.cursor
    const roll = rng()
    if (roll < 0.6) exec({ op: "deliver", replica: index, from: cursor, count: 1 + int(6) })
    else if (roll < 0.85) exec({ op: "deliver", replica: index, from: Math.max(0, cursor - 1 - int(4)), count: 1 + int(6) })
    else exec({ op: "deliver", replica: index, from: cursor + 1 + int(3), count: 1 + int(3) })
  }

  for (let step = 0; step < STEPS; step++) {
    const index = int(REPLICAS)
    const roll = rng()
    if (roll < 0.36 && pending[index]!.length < 4) create(index)
    else if (roll < 0.66) push(index)
    else if (roll < 0.73) redeliver()
    else if (roll < 0.94) sync(index)
    else if (roll < 0.97 && bumps < 3) {
      bumps++
      exec({ op: "bumpEpoch" })
    } else {
      // A hub restart: the shard must survive a canonical JSON round trip unchanged.
      stats.hubRestarts++
      const restored = JSON.parse(canonicalJson(world.hub)) as ShardState
      if (canonicalHash(restored) !== canonicalHash(world.hub)) fail("hub changed across a restart")
      world = { hub: restored, replicas: world.replicas }
    }
  }

  // Quiesce: heal the network, drain every outbox, deliver everything.
  for (let index = 0; index < REPLICAS; index++) {
    for (let guard = 0;; guard++) {
      if (guard > 200) fail(`replica ${index} never drained`)
      exec({ op: "resync", replica: index })
      const cursor = world.replicas[index]!.cursor
      exec({ op: "deliver", replica: index, from: cursor, count: world.hub.headSeq - cursor })
      const entry = pending[index]![0]
      if (entry === undefined) break
      const code = exec({
        op: "submit",
        epoch: world.replicas[index]!.epoch,
        origin: `r${index}`,
        commandId: entry.commandId,
        command: entry.command
      })
      if (!code.startsWith("E")) pending[index] = pending[index]!.filter((other) => other.commandId !== entry.commandId)
    }
  }
  for (let index = 0; index < REPLICAS; index++) {
    exec({ op: "resync", replica: index })
    const cursor = world.replicas[index]!.cursor
    exec({ op: "deliver", replica: index, from: cursor, count: world.hub.headSeq - cursor })
    exec({ op: "rebase", replica: index, pending: [] })
  }

  const hubHash = canonicalHash(world.hub.state)
  world.replicas.forEach((replica, index) => {
    if (pending[index]!.length !== 0) fail(`replica ${index} still has pending commands`)
    if (replica.cursor !== world.hub.headSeq) fail(`replica ${index} stopped at ${replica.cursor}`)
    if (replica.epoch !== world.hub.epoch) fail(`replica ${index} is on generation ${replica.epoch}`)
    if (canonicalHash(replica.confirmed) !== hubHash) fail(`replica ${index} did not converge`)
  })

  const line = JSON.stringify({ seed, detail: seed % 25 === 0, replicas: REPLICAS, ops })
  return { seed, line, results, digest, world, stats }
}

const traces: ReadonlyArray<Trace> = Array.from({ length: TRACES }, (_, index) => simulate(index + 1))

const writeTo = process.env["APP_STATE_WRITE_TRACES"]
if (writeTo !== undefined && writeTo !== "") {
  writeFileSync(writeTo, traces.map((trace) => `${trace.line}\n`).join(""))
}

describe("differential fuzz", () => {
  it("converges on all 500 traces with 0 duplicates and no cycle", () => {
    // `simulate` throws on the first violated invariant, so reaching here means all 500 passed.
    expect(traces).toHaveLength(TRACES)
    expect(new Set(traces.map((trace) => trace.line)).size).toBe(TRACES)
    const total = traces.reduce((sum, trace) => {
      for (const key of Object.keys(sum) as Array<keyof Stats>) sum[key] += trace.stats[key]
      return sum
    }, emptyStats())
    console.log(`fuzz ${JSON.stringify({ traces: TRACES, ops: traces.reduce((n, t) => n + t.results.length, 0), ...total })}`)
    expect(total.duplicateRows).toBe(0)
    for (const key of Object.keys(total) as Array<keyof Stats>) {
      if (key !== "duplicateRows") expect(total[key], `the fuzz never exercised ${key}`).toBeGreaterThan(0)
    }
  })

  it("is deterministic: the same seed yields the same trace and the same digest", () => {
    for (const seed of [1, 77, 500]) {
      const again = simulate(seed)
      const first = traces[seed - 1]!
      expect(again.line).toBe(first.line)
      expect(again.digest).toBe(first.digest)
      expect(canonicalHash(again.world)).toBe(canonicalHash(first.world))
    }
  })

  it("agrees with the Lean 4 oracle on every trace (golden differential receipt)", () => {
    expect(existsSync(FIXTURE), `missing ${FIXTURE}`).toBe(true)
    const lines = readFileSync(FIXTURE, "utf8").split("\n").filter((line) => line !== "").map((line) =>
      JSON.parse(line) as Record<string, unknown>
    )
    const trailer = lines.pop()!
    expect(trailer["trailer"]).toBe(true)
    expect(trailer["traces"]).toBe(TRACES)
    expect(lines).toHaveLength(TRACES)
    let detailed = 0
    let agreed = 0
    lines.forEach((lean, index) => {
      const trace = traces[index]!
      const label = `seed ${trace.seed}`
      expect(lean["seed"], label).toBe(trace.seed)
      expect(lean["inputFnv"], `${label}: the fixture was generated from a different trace; regenerate it`).toBe(
        fnv(FNV_INIT, `${trace.line}\n`)
      )
      expect(lean["ops"], label).toBe(trace.results.length)
      expect(lean["digest"], `${label}: Lean and TypeScript disagree on a decision or an intermediate state`).toBe(
        trace.digest
      )
      expect(lean["finalFnv"], label).toBe(fnv(FNV_INIT, canonicalJson(trace.world)))
      if (lean["results"] !== undefined) {
        detailed++
        expect(lean["results"], label).toEqual(trace.results)
        expect(canonicalJson(lean["final"]), label).toBe(canonicalJson(trace.world))
      }
      agreed++
    })
    expect(agreed).toBe(TRACES)
    expect(detailed).toBe(TRACES / 25)
  })
})
