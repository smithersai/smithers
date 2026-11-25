import { Principal } from "@smthrs/app-core"
import { ShardProtocol, ShardServer } from "@smthrs/sync"
import { Effect, Result, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { expect, test } from "vitest"
import { MCP_MAX_REQUEST_BYTES } from "../../../apps/mvp/src/features/mcp/contract.ts"
import { makeAttach } from "../../../apps/mvp/worker/attach/Attach.ts"
import { handleAttachAgent } from "../../../apps/mvp/worker/attach/AttachAgentRoutes.ts"
import { defineTool, makeMcpRoute, readBody } from "../../../apps/mvp/worker/attach/McpRoute.ts"
import { attach, redeem } from "../src/commands/AttachCommand.ts"
import { httpTransport, startNode } from "../src/commands/NodeServe.ts"

const shard = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:example/project")
const stream = Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard)
const token = "test-only-node-agent-token-never-deployed"
const replicationToken = "test-only-replication-token-never-deployed"
const syncToken = "test-only-sync-token-never-deployed"
const read = `shard:read:${shard}`
const sync = `shard:sync:${shard}`
const replicate = `shard:replicate:${shard}`
const headers = (bearer: string) => ({ authorization: `Bearer ${bearer}`, "content-type": "application/json" })
const mcpCall = (payload: object) => JSON.stringify({
  jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "shard__append", arguments: payload }
})
const mcp = (origin: string, bearer: string, payload: object) => fetch(new URL("/mcp", origin), {
  method: "POST", headers: headers(bearer), body: mcpCall(payload)
})
const pull = (requested = shard) => `/api/shard/pull?${ShardProtocol.pullQuery({
  version: 2, shard: requested, epoch: 0, after: 0, limit: 10
})}`
const snapshot = (requested = shard) => `/api/shard/snapshot?${new URLSearchParams({ shard: requested })}`
const personOrigin = "https://smithers.example"
const target = { repo: "example/project", branch: "work/branch", conversation: "one" }
const person = {
  actor: { subject: { kind: "person", id: "will" }, role: "admin" } as const,
  request: new Request(personOrigin, { headers: { origin: personOrigin } })
}
const unwrap = <A, E>(result: Result.Result<A, E>) => {
  if (Result.isFailure(result)) throw new Error(String(result.failure))
  return result.success
}

test("an agent attaches over PKCE, calls MCP, and a SQLite node syncs in both directions after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "smithers-node-"))
  const service = makeAttach({ hostOrigin: personOrigin, permissions: () => Effect.succeed(["shard:append"]) })
  const localSessions = Principal.sessions({
    [token]: { kind: "mcp", subject: "replica", session: "local", capabilities: ["shard:append"] },
    [syncToken]: { kind: "mcp", subject: "replica", session: "sync", capabilities: [read, sync] }
  })
  const verify: Principal.Verify = (evidence) => Effect.gen(function*() {
    if (evidence.kind === "mcp" && [token, syncToken].includes(evidence.tokenRef)) return yield* localSessions(evidence)
    const grant = evidence.kind === "mcp"
      ? yield* service.verifyBearer(`Bearer ${evidence.tokenRef}`, target)
      : undefined
    if (grant === undefined || Result.isFailure(grant) || grant.success.act !== "agent") {
      return yield* new Principal.AuthRefused({ reason: "unknown_credential", detail: "Agent credential required" })
    }
    return { subject: grant.success.person, session: grant.success.id, capabilities: grant.success.ceiling }
  })
  const hub = await startNode({
    file: join(dir, "hub.sqlite"), shard, node: "hub", token,
    verify: Principal.sessions({
      [token]: { kind: "mcp", subject: "hub", session: "local", capabilities: ["shard:append"] },
      [replicationToken]: { kind: "mcp", subject: "replica", session: "replication", capabilities: [replicate, read] }
    })
  })
  const transport = httpTransport(hub.origin, replicationToken)
  const options = { file: join(dir, "replica.sqlite"), shard, node: "replica", token, verify, hub: transport }
  let replica = await startNode(options)
  const route = makeMcpRoute({
    attach: service, hostOrigin: personOrigin, tools: [
      defineTool({
        name: "shard__append", description: "Append shard event", input: Schema.Struct({ side: Schema.String }),
        capability: "shard:append", policy: "agent",
        call: (_grant, payload) => Effect.promise(async () => {
          const response = await mcp(replica.origin, token, payload)
          const reply = await response.json() as { result?: { structuredContent: object } }
          if (!response.ok || reply.result === undefined || "isError" in reply.result) throw new Error("Local append refused")
          return reply.result.structuredContent
        })
      })
    ]
  })
  const edge = createServer(async (request, response) => {
    try {
      const chunks: Array<Buffer> = []
      for await (const chunk of request) chunks.push(chunk)
      const url = new URL(request.url ?? "/", replica.origin)
      const webRequest = new Request(url, {
        method: request.method ?? "POST", body: Buffer.concat(chunks).toString("utf8"),
        headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" }
      })
      const result = url.pathname.startsWith("/api/attach/")
        ? await handleAttachAgent(service, webRequest)
        : await Effect.runPromise(route(webRequest, await readBody(webRequest, MCP_MAX_REQUEST_BYTES)))
      response.writeHead(result.status, { "content-type": "application/json" }).end(await result.text())
    } catch {
      response.writeHead(500).end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    edge.once("error", reject)
    edge.listen(0, "127.0.0.1", resolve)
  })
  try {
    const address = edge.address()
    if (address === null || typeof address === "string") throw new Error("Invalid test listener")
    const origin = `http://127.0.0.1:${address.port}`
    const { reference } = unwrap(await Effect.runPromise(service.mintIntent({ ...person, ...target, ceiling: ["shard:append"] })))
    let output = ""
    await attach({
      intent: reference,
      origin,
      approve: async (pairing) => {
        const { claim } = unwrap(service.consentFor({ ...person, reference }))
        return unwrap(await Effect.runPromise(service.approveIntent({ ...person, claim, pairing }))).code
      },
      input: Readable.from([Buffer.from(JSON.stringify({
        jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "shard__append", arguments: { side: "replica" } }
      }) + "\n")]),
      output: new Writable({
        write(chunk, _encoding, callback) { output += chunk.toString(); callback() }
      })
    })
    expect(JSON.parse(output)).toMatchObject({
      id: 7, result: { structuredContent: { output: { side: "replica" }, cause: { nodeId: "shard/append" } } }
    })
    // The acknowledged outbox survives losing the process before the first sync.
    await replica.close()
    replica = await startNode(options)
    expect(await replica.sync()).toMatchObject({ position: { seq: 1 }, terminalFailures: [] })
    const hubReply = await mcp(hub.origin, token, { side: "hub" })
    expect(await hubReply.json()).toMatchObject({ result: { structuredContent: { output: { side: "hub" } } } })
    expect(await replica.sync()).toMatchObject({ position: { seq: 2 }, terminalFailures: [] })
    const { reference: next } = unwrap(await Effect.runPromise(service.mintIntent({ ...person, ...target, ceiling: ["shard:append"] })))
    const grant = await redeem({
      intent: next, origin,
      approve: async (pairing) => unwrap(await Effect.runPromise(service.approveIntent({
        ...person, claim: unwrap(service.consentFor({ ...person, reference: next })).claim, pairing
      }))).code
    })
    expect(grant.endpoint.pathname).toBe("/mcp/example/project/work%2Fbranch")
    expect((await fetch(new URL("/mcp", origin), {
      method: "POST", headers: headers(grant.token), body: mcpCall({ side: "bare" })
    })).status).toBe(404)
    expect(await (await mcp(replica.origin, token, { side: "pending" })).json())
      .toMatchObject({ result: { structuredContent: { output: { side: "pending" } } } })
    for (const [path, method] of [[pull(), "GET"], [snapshot(), "GET"], ["/api/shard/sync", "POST"]] as const) {
      expect((await fetch(new URL(path, replica.origin), { method, headers: headers(grant.token) })).status).toBe(403)
    }
    expect(await hub.sync()).toMatchObject({ position: { seq: 2 } })
    const local = httpTransport(replica.origin, syncToken)
    expect(await Effect.runPromise(local.pull({ version: 2, shard, epoch: 0, after: 0, limit: 10 })))
      .toMatchObject({ _tag: "Page", entries: [{ events: [{ side: "replica" }] }, { events: [{ side: "hub" }] }] })
    expect(await Effect.runPromise(local.snapshot(shard))).toMatchObject({ position: { shard, seq: 0 } })
    const result = await fetch(new URL("/api/shard/sync", replica.origin), { method: "POST", headers: headers(syncToken) })
    expect(await result.json()).toMatchObject({ position: { shard, seq: 3 }, terminalFailures: [] })
  } finally {
    await new Promise<void>((resolve) => edge.close(() => resolve()))
    await replica.close()
    await hub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("raw submit and journal operations enforce the grant's subject, stream, and shard", async () => {
  const other = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:other/project")
  const unrelatedToken = "test-only-other-shard-token-never-deployed"
  const node = await startNode({
    file: ":memory:", shard, node: "local", token,
    verify: Principal.sessions({
      [token]: { kind: "mcp", subject: "local", session: "append", capabilities: ["shard:append"] },
      [replicationToken]: { kind: "mcp", subject: "replica", session: "replication", capabilities: [replicate, read] },
      [unrelatedToken]: { kind: "mcp", subject: "other", session: "other", capabilities: [
        `shard:replicate:${other}`, `shard:read:${other}`, `shard:sync:${other}`
      ] }
    })
  })
  try {
    const submit = (bearer: string, originNode: string, requested = shard, requestedStream = stream) =>
      fetch(new URL("/api/shard/submit", node.origin), {
        method: "POST", headers: headers(bearer), body: JSON.stringify({
          version: 2, shard: requested, epoch: 0,
          command: { key: [originNode, "0"], stream: requestedStream, payload: { ok: true } }
        })
      })
    expect((await submit(token, "local")).status).toBe(403)
    expect((await submit(replicationToken, "local")).status).toBe(403)
    expect((await submit(replicationToken, "replica", other)).status).toBe(403)
    expect((await submit(replicationToken, "replica", shard,
      Schema.decodeUnknownSync(ShardProtocol.StreamId)(other))).status).toBe(403)
    expect((await submit(unrelatedToken, "other")).status).toBe(403)
    const accepted = await submit(replicationToken, "replica")
    expect(await accepted.json()).toMatchObject({ _tag: "Accepted", key: ["replica", "0"], position: { seq: 1 } })
    for (const path of [pull(), snapshot()]) {
      expect((await fetch(new URL(path, node.origin), { headers: headers(unrelatedToken) })).status).toBe(403)
    }
    for (const path of [pull(other), snapshot(other)]) {
      expect((await fetch(new URL(path, node.origin), { headers: headers(replicationToken) })).status).toBe(403)
    }
    expect((await fetch(new URL("/api/shard/sync", node.origin), {
      method: "POST", headers: headers(unrelatedToken)
    })).status).toBe(403)
  } finally {
    await node.close()
  }
})

test("SQLite sync reports refusals and conflicts after restart and refuses a different hub", async () => {
  const dir = mkdtempSync(join(tmpdir(), "smithers-node-sync-"))
  const authority = ShardServer.make({
    shard, store: ShardServer.memoryStore(),
    decide: (command) => command.key[1] === "1"
      ? { _tag: "Refused", reason: "payload refused" }
      : { _tag: "Accepted", events: [command.payload] }
  })
  const hub = { ...authority, origin: "https://hub.example" }
  const file = join(dir, "replica.sqlite")
  const options = {
    file, shard, node: "replica", token, hub,
    verify: Principal.sessions({
      [token]: { kind: "mcp", subject: "replica", session: "append", capabilities: ["shard:append"] },
      [syncToken]: { kind: "mcp", subject: "replica", session: "sync", capabilities: [sync] }
    })
  }
  try {
    const original = await Effect.runPromise(hub.submit({
      version: 2, shard, epoch: 0, command: { key: ["replica", "0"], stream, payload: { original: true } }
    }))
    expect(original._tag).toBe("Accepted")
    const node = await startNode(options)
    const runSync = async (origin: string) => {
      const response = await fetch(new URL("/api/shard/sync", origin), { method: "POST", headers: headers(syncToken) })
      expect(response.status).toBe(200)
      return response.json()
    }
    const result = {
      position: { shard, epoch: 0, seq: 1 },
      terminalFailures: [
        { _tag: "IdempotencyConflict", key: ["replica", "0"], position: { shard, epoch: 0, seq: 1 } },
        { _tag: "Refused", key: ["replica", "1"], reason: "payload refused" }
      ]
    }
    try {
      for (const payload of [{ value: "conflict" }, { value: "refused" }]) {
        expect(await (await mcp(node.origin, token, payload)).json())
          .toMatchObject({ result: { structuredContent: { output: payload } } })
      }
      expect(await runSync(node.origin)).toEqual(result)
    } finally {
      await node.close()
    }
    await expect(startNode({ ...options, hub: { ...hub, origin: "https://different.example" } }))
      .rejects.toThrow("another hub")
    const reopened = await startNode({ ...options, hub: { ...hub, origin: "https://HUB.example/" } })
    try {
      expect(await runSync(reopened.origin)).toEqual(result)
    } finally {
      await reopened.close()
    }
    const legacy = new DatabaseSync(file)
    legacy.exec("DROP TABLE node_replica_metadata")
    legacy.close()
    await expect(startNode(options)).rejects.toThrow("no recorded hub identity")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("authority MCP returns the original stored acknowledgment before and after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "smithers-authority-"))
  const ids = ["first", "first", "first", "second", "first", "third"]
  const verify = Principal.sessions({
    [token]: { kind: "mcp", subject: "node", session: "node", capabilities: ["shard:append"] },
    [replicationToken]: { kind: "mcp", subject: "replica", session: "replica", capabilities: [replicate, read] }
  })
  const options = {
    file: join(dir, "node.sqlite"), shard, node: "node", token, verify,
    commandId: Effect.sync(() => {
      const id = ids.shift()
      if (id === undefined) throw new Error("Unexpected command")
      return id
    })
  }
  let node = await startNode(options)
  const firstPayload = { value: "first" }
  const append = async (payload: object) => (await mcp(node.origin, token, payload)).json()
  const cause = async (ref: string) => (await fetch(new URL("/mcp", node.origin), {
    method: "POST", headers: headers(token),
    body: JSON.stringify({
      jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ref__cause", arguments: { ref } }
    })
  })).json()
  try {
    const raw = await fetch(new URL("/api/shard/submit", node.origin), {
      method: "POST", headers: headers(replicationToken),
      body: JSON.stringify({
        version: 2, shard, epoch: 0, command: { key: ["replica", "1"], stream, payload: { replicated: true } }
      })
    })
    expect(await raw.json()).toMatchObject({ _tag: "Accepted", position: { seq: 1 } })

    const first = await append(firstPayload)
    expect(first).toMatchObject({
      result: { structuredContent: {
        output: firstPayload, position: { shard, epoch: 0, seq: 2 }, journalSeq: 2,
        outputRef: "out/run-2", cause: { outputRef: "out/run-2", journalSeq: 2 }
      } }
    })
    expect(await append(firstPayload)).toEqual(first)
    expect(await append({ value: "conflict" })).toMatchObject({
      result: { isError: true, structuredContent: { code: "operation_failed", cause: "shard_commit_refused" } }
    })
    expect(await cause("out/run-2")).toMatchObject({
      result: { structuredContent: {
        cursor: "2", rows: [first.result.structuredContent.cause]
      } }
    })
    expect(await cause("out/run-3")).toMatchObject({
      result: { isError: true, structuredContent: { code: "provenance_missing" } }
    })
    const second = await append({ value: "second" })
    expect(second).toMatchObject({ result: { structuredContent: { outputRef: "out/run-3", journalSeq: 3 } } })
    expect(await node.sync()).toEqual({ position: { shard, epoch: 0, seq: 3 }, terminalFailures: [] })

    await node.close()
    node = await startNode(options)
    expect(await cause("out/run-2")).toMatchObject({
      result: { structuredContent: {
        cursor: "3", rows: [first.result.structuredContent.cause]
      } }
    })
    expect(await append(firstPayload)).toEqual(first)
    expect(await cause("out/run-2")).toMatchObject({ result: { structuredContent: { cursor: "3" } } })
    expect(await append({ value: "third" })).toMatchObject({
      result: { structuredContent: { outputRef: "out/run-4", journalSeq: 4, position: { seq: 4 } } }
    })
    expect(await node.sync()).toEqual({ position: { shard, epoch: 0, seq: 4 }, terminalFailures: [] })
  } finally {
    await node.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loopback Host and Origin are checked before the node routes a request", async () => {
  const node = await startNode({ file: ":memory:", shard, node: "node", token })
  try {
    const port = new URL(node.origin).port
    const request = (host: string, origin?: string) => new Promise<number | undefined>((resolve, reject) => {
      const outgoing = httpRequest(new URL("/mcp", node.origin), {
        method: "POST", headers: { ...headers(token), host, ...(origin === undefined ? {} : { origin }) }
      }, (response) => {
        response.resume()
        resolve(response.statusCode)
      })
      outgoing.once("error", reject)
      outgoing.end(mcpCall({ valid: true }))
    })
    expect(await request(`127.0.0.1:${port}`)).toBe(200)
    expect(await request(`localhost:${port}`, `http://localhost:${port}`)).toBe(200)
    expect(await request(`127.0.0.1:${port}`, node.origin)).toBe(200)
    expect(await request("external.example")).toBe(403)
    expect(await request(`127.0.0.1:${port}`, "https://external.example")).toBe(403)
    expect(await request(`127.0.0.1:${port}`, "http://localhost:1")).toBe(403)
    expect(await node.sync()).toMatchObject({ position: { seq: 3 } })
  } finally {
    await node.close()
  }
})

test("node counts chunked raw bytes before buffering and decodes split UTF-8", async () => {
  const node = await startNode({ file: ":memory:", shard, node: "node", token })
  try {
    const send = (write: (request: ReturnType<typeof httpRequest>) => void) =>
      new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const outgoing = httpRequest(new URL("/mcp", node.origin), { method: "POST", headers: headers(token) },
          (response) => {
            response.setEncoding("utf8")
            let body = ""
            response.on("data", (text) => { body += text })
            response.once("end", () => {
              resolve({ status: response.statusCode, body })
              outgoing.destroy()
            })
            response.once("error", reject)
          })
        outgoing.once("error", reject)
        outgoing.setTimeout(1_000, () => outgoing.destroy(new Error("Node waited for the rest of the HTTP body")))
        write(outgoing)
      })
    const oversized = await send((request) => {
      // Send an unterminated chunked message whose character count is below the byte cap.
      request.write(Buffer.from("é".repeat(524_289)))
    })
    expect(oversized.status).toBe(413)
    const wire = Buffer.from(mcpCall({ value: "a😀b" }))
    const withinCharacter = wire.indexOf(Buffer.from("😀")) + 2
    const split = await send((request) => {
      request.write(wire.subarray(0, withinCharacter))
      setTimeout(() => request.end(wire.subarray(withinCharacter)), 20)
    })
    expect(split.status).toBe(200)
    expect(JSON.parse(split.body)).toMatchObject({ result: { structuredContent: { output: { value: "a😀b" } } } })
    expect(await node.sync()).toMatchObject({ position: { seq: 1 } })
  } finally {
    await node.close()
  }
})
