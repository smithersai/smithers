import { Core, McpAdapter, Principal } from "@smthrs/app-core"
import { ShardClient, ShardProtocol, ShardServer } from "@smthrs/sync"
import { Effect, Schema } from "effect"
import { Cli, z } from "incur"
import { createServer, type IncomingMessage } from "node:http"
import { DatabaseSync } from "node:sqlite"
import { normalizeOrigin, serveMcpStdioBridge } from "../cli/McpRemote.ts"

const appendCapability = "shard:append"
const scopedCapability = (operation: "read" | "sync" | "replicate", shard: string) => `shard:${operation}:${shard}`
const decodeShard = Schema.decodeUnknownSync(ShardProtocol.ShardId)
const decodeStream = Schema.decodeUnknownSync(ShardProtocol.StreamId)
const decodeSubmit = Schema.decodeUnknownSync(ShardProtocol.SubmitRequest)
const bodyLimit = 1_048_576

class RequestTooLarge extends Error {}

const readBody = async (request: IncomingMessage): Promise<string> => {
  if (Number(request.headers["content-length"]) > bodyLimit) throw new RequestTooLarge()
  const chunks: Array<Buffer> = []
  let bytes = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = chunk as Buffer
    bytes += buffer.byteLength
    if (bytes > bodyLimit) throw new RequestTooLarge()
    chunks.push(buffer)
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))
}

export interface NodeHub extends ShardClient.Transport {
  readonly origin: string
}

export const httpTransport = (origin: string, token: string): NodeHub => {
  const base = normalizeOrigin(origin)
  const request = <A>(path: string, decode: (input: unknown) => A, body?: unknown) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(new URL(path, base), {
          signal,
          redirect: "error",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) })
        })
        if (!response.ok) throw new Error("Hub refused shard request")
        return decode(await response.json())
      },
      catch: () => new ShardProtocol.ShardError({ reason: "out_of_range", message: "Hub shard request failed" })
    })
  return {
    origin: base,
    submit: (command) =>
      request("/api/shard/submit", Schema.decodeUnknownSync(ShardProtocol.SubmitResponse), command),
    pull: (pull) =>
      request(`/api/shard/pull?${ShardProtocol.pullQuery(pull)}`, Schema.decodeUnknownSync(ShardProtocol.PullResponse)),
    snapshot: (shard) =>
      request(`/api/shard/snapshot?${new URLSearchParams({ shard })}`,
        Schema.decodeUnknownSync(ShardProtocol.SnapshotResponse))
  }
}

type AuthorityRun = Core.Requested & { readonly position: ShardProtocol.ShardPosition }

interface Data {
  readonly shard: string
  readonly node: string
  readonly mode: "authority" | "replica"
  readonly head: ShardServer.Head
  readonly entries: ReadonlyArray<ShardProtocol.Entry>
  readonly receipts: Readonly<Record<string, ShardServer.Receipt>>
  readonly authorityRuns?: Readonly<Record<string, AuthorityRun>>
  readonly client: ShardClient.ClientState
}

export interface NodeOptions {
  readonly file: string
  readonly shard: string
  readonly node: string
  readonly token: string
  readonly verify?: Principal.Verify
  readonly hub?: NodeHub
  readonly commandId?: Effect.Effect<string>
  readonly port?: number
}

export const startNode = async (options: NodeOptions) => {
  if (options.token.length < 24) throw new Error("Node requires an agent token of at least 24 characters")
  const shard = decodeShard(options.shard)
  const stream = decodeStream(options.shard)
  const hubOrigin = options.hub === undefined ? null : normalizeOrigin(options.hub.origin)
  const db = new DatabaseSync(options.file)
  try {
    db.exec("PRAGMA locking_mode = EXCLUSIVE")
    db.exec("BEGIN EXCLUSIVE; COMMIT")
    db.exec("CREATE TABLE IF NOT EXISTS node_shard (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)")
    db.exec("CREATE TABLE IF NOT EXISTS node_replica_metadata (id INTEGER PRIMARY KEY CHECK (id = 1), hub_origin TEXT NOT NULL)")
    const select = db.prepare("SELECT state FROM node_shard WHERE id = 1")
    const write = db.prepare("INSERT OR REPLACE INTO node_shard (id, state) VALUES (1, ?)")
    const saved = select.get() as { state: string } | undefined
    const mode = options.hub === undefined ? "authority" : "replica"
    let data: Data = saved === undefined
      ? {
        shard, node: options.node, mode, head: { epoch: 0, head: 0, floor: 0, snapshot: null }, entries: [],
        receipts: {}, client: ShardClient.initialState
      }
      : JSON.parse(saved.state) as Data
    if (data.shard !== shard || data.node !== options.node || data.mode !== mode) {
      throw new Error("SQLite belongs to a different shard, node or mode")
    }
    const metadata = db.prepare("SELECT hub_origin FROM node_replica_metadata WHERE id = 1")
      .get() as { hub_origin: string } | undefined
    if (mode === "replica" && saved !== undefined && metadata?.hub_origin !== hubOrigin) {
      throw new Error("SQLite replica belongs to another hub or has no recorded hub identity")
    }
    if (saved === undefined) {
      db.exec("BEGIN IMMEDIATE")
      write.run(JSON.stringify(data))
      if (hubOrigin !== null) {
        db.prepare("INSERT INTO node_replica_metadata (id, hub_origin) VALUES (1, ?)").run(hubOrigin)
      }
      db.exec("COMMIT")
    }
    const atomic = <A>(body: () => A): A => {
      const previous = data
      db.exec("BEGIN IMMEDIATE")
      try {
        const value = body()
        if (data !== previous) write.run(JSON.stringify(data))
        db.exec("COMMIT")
        return value
      } catch (error) {
        data = previous
        db.exec("ROLLBACK")
        throw error
      }
    }
    const keyOf = (key: ShardProtocol.CommandKey) => JSON.stringify(key)
    const local = ShardServer.make({
      shard,
      store: {
        atomic,
        head: () => data.head,
        setHead: (head) => { data = { ...data, head } },
        receipt: (key) => data.receipts[keyOf(key)],
        putReceipt: (key, receipt) => { data = { ...data, receipts: { ...data.receipts, [keyOf(key)]: receipt } } },
        append: (entry) => { data = { ...data, entries: [...data.entries, entry] } },
        read: (after, limit) => data.entries.filter((entry) => entry.seq > after).slice(0, limit),
        dropThrough: (seq) => { data = { ...data, entries: data.entries.filter((entry) => entry.seq > seq) } }
      }
    })
    const replica = options.hub === undefined ? undefined : await Effect.runPromise(ShardClient.make({
      shard,
      node: options.node,
      transport: options.hub,
      store: {
        load: Effect.sync(() => data.client),
        modify: (f) => Effect.sync(() => atomic(() => {
          const [value, client] = f(data.client)
          data = { ...data, client }
          return value
        }))
      },
      apply: (delivery) => Effect.sync(() => atomic(() => {
        if (delivery._tag === "Reset") {
          const { position, state } = delivery.snapshot
          data = { ...data, head: { epoch: position.epoch, head: position.seq, floor: position.seq, snapshot: state }, entries: [] }
        } else {
          data = {
            ...data,
            head: { ...data.head, head: delivery.through.seq, epoch: delivery.through.epoch },
            entries: [...data.entries.filter((entry) => entry.seq < delivery.entries[0]!.seq), ...delivery.entries]
          }
        }
      }))
    }))
    const sync = Effect.gen(function*() {
      const position = yield* (replica?.sync ?? local.head)
      return { position, terminalFailures: data.client.terminalFailures ?? [] }
    })
    const verify = options.verify ?? Principal.sessions({
      [options.token]: { kind: "mcp", subject: options.node, session: options.node, capabilities: [appendCapability] }
    })
    const credentials = Principal.make({ verify })
    const commandId = options.commandId ?? Effect.sync(() => globalThis.crypto.randomUUID())
    const commitRefused = () => new Core.CoreError({
      reason: "operation_failed", target: "shard/append", code: "shard_commit_refused",
      detail: "The shard did not commit the command."
    })
    const commitAuthority = (payload: Core.Json, atSequence: (seq: number) => Core.Requested) =>
      Effect.gen(function*() {
        const key = [options.node, yield* commandId] as const
        const { epoch } = yield* local.head
        const result = yield* local.submit({
          version: 2, shard, epoch,
          command: { key, stream, payload }
        }, (position) => {
          const run = { ...atSequence(position.seq), position }
          data = { ...data, authorityRuns: { ...data.authorityRuns, [keyOf(key)]: run } }
        }).pipe(Effect.mapError(commitRefused))
        // Duplicate is returned only after checking the stored command hash.
        if (
          (result._tag !== "Accepted" && result._tag !== "Duplicate") ||
          result.key[0] !== key[0] || result.key[1] !== key[1] || result.position.shard !== shard
        ) return yield* commitRefused()

        const saved = data.authorityRuns?.[keyOf(key)]
        if (saved !== undefined) {
          return { _tag: result._tag === "Accepted" ? "Committed" : "Duplicate", run: saved } as const
        }
        if (result._tag === "Accepted") return yield* commitRefused()
        // Older files retained the command hash and position. The append output
        // is the verified payload, and its cause is determined by that position.
        return { _tag: "Duplicate", run: { ...atSequence(result.position.seq), position: result.position } } as const
      })
    const engine = await Effect.runPromise(Core.make({
      credentials,
      initialJournalSeq: replica === undefined ? data.head.head : data.client.nextCommand,
      ...(replica === undefined
        ? {
          commit: commitAuthority,
          initialReceipts: Object.values(data.authorityRuns ?? {}).map(({ cause }) => ({ receipt: cause }))
        }
        : { persist: (run: Core.Requested) => Effect.asVoid(replica.enqueue(stream, run.output)) }),
      flows: [{
        tag: "shard/append",
        title: "Append shard event",
        capabilities: [appendCapability],
        payload: { type: "object", properties: {}, additionalProperties: true },
        run: (payload) => payload
      }]
    }))
    const server = createServer(async (request, response) => {
      try {
        const host = request.headers.host?.toLowerCase()
        const port = request.socket.localPort
        const origin = request.headers.origin
        if (
          request.headersDistinct.host?.length !== 1 ||
          !["localhost", "127.0.0.1", `localhost:${port}`, `127.0.0.1:${port}`].includes(host ?? "") ||
          (origin !== undefined && origin !== `http://localhost:${port}` && origin !== `http://127.0.0.1:${port}`)
        ) {
          response.writeHead(403).end()
          return
        }
        const path = request.url ?? "/"
        if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
          response.writeHead(400).end()
          return
        }
        const url = new URL(path, "http://localhost")
        const tokenRef = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "")?.[1]
        if (tokenRef === undefined) { response.writeHead(401).end(); return }
        const evidence = { kind: "mcp", transport: "http", tokenRef } as const
        const json = (value: unknown) => response.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(value))
        if (request.method === "POST" && url.pathname === "/mcp") {
          const connection = await Effect.runPromise(Effect.result(McpAdapter.make({ engine, evidence })))
          if (connection._tag === "Failure") { response.writeHead(401).end(); return }
          const message = await Effect.runPromise(connection.success.handle(await readBody(request)))
          if (message === undefined) response.writeHead(202).end()
          else response.writeHead(200, { "content-type": "application/json" }).end(message)
          return
        }
        const principal = await Effect.runPromise(Effect.result(credentials.mint(evidence)))
        if (principal._tag === "Failure") { response.writeHead(401).end(); return }
        const authority = credentials.authority(principal.success)
        if (authority?.act !== "agent") { response.writeHead(403).end(); return }
        const holds = (capability: "replicate" | "read" | "sync") =>
          authority.capabilities.includes(scopedCapability(capability, shard))
        if (request.method === "POST" && url.pathname === "/api/shard/submit" && replica === undefined) {
          if (!holds("replicate")) { response.writeHead(403).end(); return }
          const submit = decodeSubmit(JSON.parse(await readBody(request)))
          if (submit.command.key[0] !== authority.subject || submit.command.stream !== stream || submit.shard !== shard) {
            response.writeHead(403).end()
            return
          }
          json(await Effect.runPromise(local.submit(submit)))
        } else if (request.method === "GET" && url.pathname === "/api/shard/pull") {
          if (!holds("read") || url.searchParams.get("shard") !== shard) { response.writeHead(403).end(); return }
          json(await Effect.runPromise(local.pull(await Effect.runPromise(ShardProtocol.decodePullQuery(url.searchParams)))))
        } else if (request.method === "GET" && url.pathname === "/api/shard/snapshot") {
          if (!holds("read") || url.searchParams.get("shard") !== shard) { response.writeHead(403).end(); return }
          json(await Effect.runPromise(local.snapshot(shard)))
        } else if (request.method === "POST" && url.pathname === "/api/shard/sync") {
          if (!holds("sync")) { response.writeHead(403).end(); return }
          json(await Effect.runPromise(sync))
        } else {
          response.writeHead(404).end()
        }
      } catch (error) {
        if (error instanceof RequestTooLarge) {
          response.writeHead(413, { connection: "close" }).end()
        } else {
          response.writeHead(400).end()
        }
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(options.port ?? 0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("Node failed to bind TCP")
    return {
      origin: `http://127.0.0.1:${address.port}`,
      sync: () => Effect.runPromise(sync),
      close: () => new Promise<void>((resolve, reject) => server.close((error) => {
        db.close()
        if (error === undefined) resolve()
        else reject(error)
      }))
    }
  } catch (error) {
    db.close()
    throw error
  }
}

export const registerNode = () => Cli.create("node", { description: "Local Smithers node" }).command("serve", {
  description: "Serve a local SQLite shard and stdio MCP",
  options: z.object({
    file: z.string(), shard: z.string(), node: z.string(), port: z.coerce.number().int().min(0).max(65_535).default(0),
    hub: z.string().optional(), replicationNode: z.string().min(1).optional()
  }),
  run: async ({ options }) => {
    const token = process.env["SMITHERS_NODE_AGENT_TOKEN"] ?? ""
    const hubToken = process.env["SMITHERS_HUB_AGENT_TOKEN"]
    const replicationToken = process.env["SMITHERS_NODE_REPLICATION_TOKEN"]
    const syncToken = process.env["SMITHERS_NODE_SYNC_TOKEN"]
    const { hub, replicationNode, ...local } = options
    if (hub !== undefined && !hubToken) throw new Error("A hub replication token is required")
    if ((replicationToken === undefined) !== (replicationNode === undefined) || replicationNode === local.node) {
      throw new Error("Configure a dedicated node replication token and a distinct replication node ID")
    }
    const tokens = [token, replicationToken, syncToken].filter((value): value is string => value !== undefined)
    if (tokens.some((value) => value.length < 24) || new Set(tokens).size !== tokens.length) {
      throw new Error("Local node tokens must be distinct and at least 24 characters")
    }
    const grants: Record<string, Principal.Grant> = {
      [token]: { kind: "mcp", subject: local.node, session: local.node, capabilities: [appendCapability] }
    }
    if (replicationToken !== undefined && replicationNode !== undefined) {
      grants[replicationToken] = {
        kind: "mcp", subject: replicationNode, session: replicationNode,
        capabilities: [scopedCapability("replicate", local.shard), scopedCapability("read", local.shard)]
      }
    }
    if (syncToken !== undefined) {
      grants[syncToken] = {
        kind: "mcp", subject: local.node, session: local.node,
        capabilities: [scopedCapability("read", local.shard), scopedCapability("sync", local.shard)]
      }
    }
    const node = await startNode({
      ...local, token, verify: Principal.sessions(grants),
      ...(hub === undefined ? {} : { hub: httpTransport(hub, hubToken!) })
    })
    const abort = new AbortController()
    const stop = () => abort.abort()
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
    const stopped = new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }))
    try {
      process.stderr.write(`Smithers node listening on ${node.origin}\n`)
      await serveMcpStdioBridge({ agentGrant: { token, endpoint: new URL("/mcp", node.origin) }, signal: abort.signal })
      await stopped
    } finally {
      process.stdin.pause()
      process.off("SIGINT", stop)
      process.off("SIGTERM", stop)
      await node.close()
    }
  }
})
