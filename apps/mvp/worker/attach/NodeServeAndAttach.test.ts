import { Principal } from "@smthrs/app-core"
import { ShardProtocol } from "@smthrs/sync"
import { Effect, Result, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { expect, test } from "vitest"
import { MCP_MAX_REQUEST_BYTES } from "../../src/features/mcp/contract.ts"
import { makeAttach } from "./Attach.vibe"
import { handleAttachAgent } from "./AttachAgentRoutes.ts"
import { defineTool, makeMcpRoute, readBody } from "./McpRoute.vibe"
import { makeCli } from "@smthrs/cli/Cli"
import { redeem } from "../../../../packages/smithers/src/commands/AttachCommand.ts"
import { httpTransport, startNode } from "../../../../packages/smithers/src/commands/NodeServe.ts"

const shard = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:example/project")
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
    const environment = { SMITHERS_DELEGATE_ACT: "agent" }
    const cli = makeCli({
      environment,
      attachApproval: async (pairing) => {
        const { claim } = unwrap(service.consentFor({ ...person, reference }))
        return unwrap(await Effect.runPromise(service.approveIntent({ ...person, claim, pairing }))).code
      },
      mcpStdio: {
        input: Readable.from([Buffer.from(mcpCall({ side: "replica" }) + "\n")]),
        output: new Writable({
          write(chunk, _encoding, callback) { output += chunk.toString(); callback() }
        }),
      },
    })
    let exit = 0
    let cliOutput = ""
    await cli.serve(["attach", "--intent", reference, "--origin", origin], {
      env: environment, exit: (code) => { exit = code }, stdout: (chunk) => { cliOutput += chunk },
    })
    expect(exit, cliOutput).toBe(0)
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
