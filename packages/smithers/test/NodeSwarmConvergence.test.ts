// M1 Track C (plan/m1/self-hosted-node-swarm), decision 0170: one hub node sequences a repository shard on SQLite, and
// two local-first peer nodes keep working while the hub is unreachable. Every node here is a real `startNode` over its
// own SQLite file, and every replica reaches the hub over loopback HTTP. Only reachability is scripted: the transport
// a peer uses can be cut, can lose an acknowledgment after the hub committed, and can deliver every request twice.
import { Principal } from "@smthrs/app-core"
import { ShardProtocol } from "@smthrs/sync"
import { Effect, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { httpTransport, type NodeHub, startNode } from "../src/commands/NodeServe.ts"

const shard = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:example/swarm")
const read = `shard:read:${shard}`
const sync = `shard:sync:${shard}`
const replicate = `shard:replicate:${shard}`
const appendToken = "test-only-swarm-append-token-never-deployed"
const syncToken = "test-only-swarm-sync-token-never-deployed"
const peerToken = { "peer-a": "test-only-peer-a-replication-never-deployed", "peer-b": "test-only-peer-b-replication-never-deployed" }
type Peer = keyof typeof peerToken

/** A peer's link to the hub: `online` cuts it, `loseAck` drops the next answer after the hub commits, `twice` resends. */
interface Link extends NodeHub {
  online: boolean
  loseAck: number
  twice: boolean
  submits: number
}

const link = (hub: NodeHub): Link => {
  const offline = () => new ShardProtocol.ShardError({ reason: "out_of_range", message: "Hub unreachable" })
  const guard = <A>(send: () => Effect.Effect<A, ShardProtocol.ShardError>) =>
    Effect.suspend(() => {
      if (!state.online) return Effect.fail(offline())
      // A duplicate delivery: the same request reaches the hub twice, and the client sees the second answer.
      return state.twice ? Effect.andThen(send(), send()) : send()
    })
  const state: Link = {
    origin: hub.origin,
    online: true,
    loseAck: 0,
    twice: false,
    submits: 0,
    submit: (request) =>
      guard(() => {
        state.submits++
        return hub.submit(request)
      }).pipe(Effect.flatMap((answer) => {
        if (state.loseAck === 0) return Effect.succeed(answer)
        state.loseAck--
        return Effect.fail(offline())
      })),
    pull: (request) => guard(() => hub.pull(request)),
    snapshot: (requested) => guard(() => hub.snapshot(requested))
  }
  return state
}

const headers = (bearer: string) => ({ authorization: `Bearer ${bearer}`, "content-type": "application/json" })

/** Appends a Plan Tree event through the node's own MCP, as a local agent does. */
const append = async (origin: string, payload: PlanEvent) => {
  const response = await fetch(new URL("/mcp", origin), {
    method: "POST", headers: headers(appendToken),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "shard__append", arguments: payload } })
  })
  const reply = await response.json() as { result?: { isError?: boolean; structuredContent: { output: unknown } } }
  expect(response.status).toBe(200)
  expect(reply.result?.isError).toBeUndefined()
  expect(reply.result?.structuredContent.output).toEqual(payload)
}

/** Every entry a node serves, read through its loopback shard API. */
const entriesOf = async (origin: string) => {
  const reply = await Effect.runPromise(httpTransport(origin, syncToken).pull({
    version: ShardProtocol.protocolVersion, shard, epoch: 0, after: 0, limit: 10_000
  }))
  if (reply._tag !== "Page") throw new Error("Node answered Resync")
  expect(reply.done).toBe(true)
  return reply
}

interface PlanEvent {
  readonly op: "plan" | "status"
  readonly id: string
  readonly parent?: string
  readonly status?: string
}

/** Folds the shard into a Plan Tree: each node's parent and latest status, as text with sorted keys. */
const planTree = (entries: ReadonlyArray<ShardProtocol.Entry>) => {
  const tree: Record<string, { parent: string | null; status: string }> = {}
  for (const entry of entries) {
    for (const event of entry.events as unknown as ReadonlyArray<PlanEvent>) {
      if (event.op === "plan") tree[event.id] = { parent: event.parent ?? null, status: "pending" }
      else if (tree[event.id] !== undefined) tree[event.id] = { ...tree[event.id]!, status: event.status ?? "pending" }
    }
  }
  return JSON.stringify(Object.keys(tree).sort().map((id) => [id, tree[id]]))
}

test("two peers append offline, reconnect in reverse order over duplicated deliveries, and converge with the hub", async () => {
  const dir = mkdtempSync(join(tmpdir(), "smithers-swarm-"))
  const sessions = (node: string, extra: Record<string, Principal.Grant> = {}) => Principal.sessions({
    [appendToken]: { kind: "mcp", subject: node, session: `${node}-append`, capabilities: ["shard:append"] },
    [syncToken]: { kind: "mcp", subject: node, session: `${node}-sync`, capabilities: [read, sync] },
    ...extra
  })
  const hub = await startNode({
    file: join(dir, "hub.sqlite"), shard, node: "hub", token: appendToken,
    verify: sessions("hub", Object.fromEntries((Object.keys(peerToken) as Array<Peer>).map((peer) => [
      peerToken[peer], { kind: "mcp", subject: peer, session: `${peer}-replication`, capabilities: [replicate, read] }
    ])))
  })
  const links = {
    "peer-a": link(httpTransport(hub.origin, peerToken["peer-a"])),
    "peer-b": link(httpTransport(hub.origin, peerToken["peer-b"]))
  }
  const options = (peer: Peer) => ({
    file: join(dir, `${peer}.sqlite`), shard, node: peer, token: appendToken, verify: sessions(peer), hub: links[peer]
  })
  const peers = { "peer-a": await startNode(options("peer-a")), "peer-b": await startNode(options("peer-b")) }
  try {
    // Online baseline: the hub plans the root and both peers pull it.
    await append(hub.origin, { op: "plan", id: "root" })
    for (const peer of ["peer-a", "peer-b"] as const) {
      expect(await peers[peer].sync()).toMatchObject({ position: { seq: 1 }, terminalFailures: [] })
    }

    // Both peers lose the hub and keep working on their own disks. The hub keeps sequencing its own work.
    links["peer-a"].online = false
    links["peer-b"].online = false
    await append(peers["peer-a"].origin, { op: "plan", id: "a1", parent: "root" })
    await append(peers["peer-a"].origin, { op: "status", id: "root", status: "running" })
    await append(peers["peer-b"].origin, { op: "plan", id: "b1", parent: "root" })
    await append(peers["peer-b"].origin, { op: "plan", id: "b2", parent: "b1" })
    await append(peers["peer-b"].origin, { op: "status", id: "a1", status: "blocked" })
    await append(hub.origin, { op: "plan", id: "h1", parent: "root" })
    for (const peer of ["peer-a", "peer-b"] as const) {
      await expect(peers[peer].sync()).rejects.toThrow()
      expect((await entriesOf(peers[peer].origin)).through).toBe(1)
    }

    // A peer that restarts while offline keeps its unacknowledged outbox.
    await peers["peer-a"].close()
    peers["peer-a"] = await startNode(options("peer-a"))

    // Reconnect in reverse order: peer-b first, and its first push loses the hub's acknowledgment after committing.
    links["peer-b"].online = true
    links["peer-b"].loseAck = 1
    await expect(peers["peer-b"].sync()).rejects.toThrow()
    links["peer-b"].twice = true
    expect(await peers["peer-b"].sync()).toMatchObject({ position: { seq: 5 }, terminalFailures: [] })

    links["peer-a"].online = true
    links["peer-a"].twice = true
    expect(await peers["peer-a"].sync()).toMatchObject({ position: { seq: 7 }, terminalFailures: [] })
    // Every peer command reached the hub more than once; none was sequenced twice.
    expect(links["peer-b"].submits).toBeGreaterThan(3)
    expect(links["peer-a"].submits).toBeGreaterThan(2)

    // A second round over the duplicating links changes nothing, and peer-b catches up on peer-a's work.
    for (const peer of ["peer-b", "peer-a"] as const) {
      expect(await peers[peer].sync()).toMatchObject({ position: { seq: 7 }, terminalFailures: [] })
    }

    const served = await Promise.all([hub.origin, peers["peer-a"].origin, peers["peer-b"].origin].map(entriesOf))
    const [authority] = served
    // hubSeq is gap-free and strictly increasing, and each (origin node, command id) appears once.
    expect(authority!.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
    const keys = authority!.entries.map((entry) => JSON.stringify(entry.key))
    expect(new Set(keys).size).toBe(keys.length)
    expect(authority!.entries.map((entry) => entry.key[0]).sort())
      .toEqual(["hub", "hub", "peer-a", "peer-a", "peer-b", "peer-b", "peer-b"])
    // Hub and both peers serve the same bytes and fold the same Plan Tree.
    for (const replica of served.slice(1)) {
      expect(JSON.stringify(replica.entries)).toBe(JSON.stringify(authority!.entries))
      expect(replica.through).toBe(authority!.through)
    }
    const trees = served.map((page) => planTree(page.entries))
    expect(new Set(trees).size).toBe(1)
    // The hub's order decides: peer-b's status for a1 (seq 5) precedes peer-a's plan of a1 (seq 6), which resets it.
    expect(JSON.parse(trees[0]!)).toEqual([
      ["a1", { parent: "root", status: "pending" }],
      ["b1", { parent: "root", status: "pending" }],
      ["b2", { parent: "b1", status: "pending" }],
      ["h1", { parent: "root", status: "pending" }],
      ["root", { parent: null, status: "running" }]
    ])

    // Each peer's state survives a restart byte for byte.
    for (const peer of ["peer-a", "peer-b"] as const) {
      await peers[peer].close()
      peers[peer] = await startNode(options(peer))
      expect(JSON.stringify((await entriesOf(peers[peer].origin)).entries)).toBe(JSON.stringify(authority!.entries))
    }
  } finally {
    for (const node of Object.values(peers)) await node.close()
    await hub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
