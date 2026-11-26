import { Principal } from "@smthrs/app-core"
import { ShardProtocol, ShardServer } from "@smthrs/sync"
import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "vitest"
import { makeCli } from "../src/Cli.ts"
import { httpTransport, startNode } from "../src/commands/NodeServe.ts"
import { executable, runIn, scriptedHost } from "./support/bin.ts"

const shard = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:example/project")
const stream = Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard)
const token = "test-only-node-agent-token-never-deployed"
const replicationToken = "test-only-replication-token-never-deployed"
const syncToken = "test-only-sync-token-never-deployed"
const read = `shard:read:${shard}`
const sync = `shard:sync:${shard}`
const replicate = `shard:replicate:${shard}`
const headers = (bearer: string) => ({ authorization: `Bearer ${bearer}`, "content-type": "application/json" })
const mcpCall = (payload: object) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "shard__append", arguments: payload }
  })
const mcp = (origin: string, bearer: string, payload: object) =>
  fetch(new URL("/mcp", origin), {
    method: "POST",
    headers: headers(bearer),
    body: mcpCall(payload)
  })
const pull = (requested = shard) =>
  `/api/shard/pull?${
    ShardProtocol.pullQuery({
      version: 2,
      shard: requested,
      epoch: 0,
      after: 0,
      limit: 10
    })
  }`
const snapshot = (requested = shard) => `/api/shard/snapshot?${new URLSearchParams({ shard: requested })}`
test("raw submit and journal operations enforce the grant's subject, stream, and shard", async () => {
  const other = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:other/project")
  const unrelatedToken = "test-only-other-shard-token-never-deployed"
  const node = await startNode({
    file: ":memory:",
    shard,
    node: "local",
    token,
    verify: Principal.sessions({
      [token]: { kind: "mcp", subject: "local", session: "append", capabilities: ["shard:append"] },
      [replicationToken]: { kind: "mcp", subject: "replica", session: "replication", capabilities: [replicate, read] },
      [unrelatedToken]: {
        kind: "mcp",
        subject: "other",
        session: "other",
        capabilities: [
          `shard:replicate:${other}`,
          `shard:read:${other}`,
          `shard:sync:${other}`
        ]
      }
    })
  })
  try {
    const submit = (bearer: string, originNode: string, requested = shard, requestedStream = stream) =>
      fetch(new URL("/api/shard/submit", node.origin), {
        method: "POST",
        headers: headers(bearer),
        body: JSON.stringify({
          version: 2,
          shard: requested,
          epoch: 0,
          command: { key: [originNode, "0"], stream: requestedStream, payload: { ok: true } }
        })
      })
    expect((await submit(token, "local")).status).toBe(403)
    expect((await submit(replicationToken, "local")).status).toBe(403)
    expect((await submit(replicationToken, "replica", other)).status).toBe(403)
    expect(
      (await submit(replicationToken, "replica", shard, Schema.decodeUnknownSync(ShardProtocol.StreamId)(other))).status
    ).toBe(403)
    expect((await submit(unrelatedToken, "other")).status).toBe(403)
    const accepted = await submit(replicationToken, "replica")
    expect(await accepted.json()).toMatchObject({ _tag: "Accepted", key: ["replica", "0"], position: { seq: 1 } })
    for (const path of [pull(), snapshot()]) {
      expect((await fetch(new URL(path, node.origin), { headers: headers(unrelatedToken) })).status).toBe(403)
    }
    for (const path of [pull(other), snapshot(other)]) {
      expect((await fetch(new URL(path, node.origin), { headers: headers(replicationToken) })).status).toBe(403)
    }
    expect(
      (await fetch(new URL("/api/shard/sync", node.origin), {
        method: "POST",
        headers: headers(unrelatedToken)
      })).status
    ).toBe(403)
  } finally {
    await node.close()
  }
})

test("SQLite sync reports refusals and conflicts after restart and refuses a different hub", async () => {
  const dir = mkdtempSync(join(tmpdir(), "smithers-node-sync-"))
  const authority = ShardServer.make({
    shard,
    store: ShardServer.memoryStore(),
    decide: (command) =>
      command.key[1] === "1"
        ? { _tag: "Refused", reason: "payload refused" }
        : { _tag: "Accepted", events: [command.payload] }
  })
  const hub = { ...authority, origin: "https://hub.example" }
  const file = join(dir, "replica.sqlite")
  const options = {
    file,
    shard,
    node: "replica",
    token,
    hub,
    verify: Principal.sessions({
      [token]: { kind: "mcp", subject: "replica", session: "append", capabilities: ["shard:append"] },
      [syncToken]: { kind: "mcp", subject: "replica", session: "sync", capabilities: [sync] }
    })
  }
  try {
    const original = await Effect.runPromise(hub.submit({
      version: 2,
      shard,
      epoch: 0,
      command: { key: ["replica", "0"], stream, payload: { original: true } }
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
    file: join(dir, "node.sqlite"),
    shard,
    node: "node",
    token,
    verify,
    commandId: Effect.sync(() => {
      const id = ids.shift()
      if (id === undefined) throw new Error("Unexpected command")
      return id
    })
  }
  let node = await startNode(options)
  const firstPayload = { value: "first" }
  const append = async (payload: object) => (await mcp(node.origin, token, payload)).json()
  const cause = async (ref: string) =>
    (await fetch(new URL("/mcp", node.origin), {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "ref__cause", arguments: { ref } }
      })
    })).json()
  try {
    const raw = await fetch(new URL("/api/shard/submit", node.origin), {
      method: "POST",
      headers: headers(replicationToken),
      body: JSON.stringify({
        version: 2,
        shard,
        epoch: 0,
        command: { key: ["replica", "1"], stream, payload: { replicated: true } }
      })
    })
    expect(await raw.json()).toMatchObject({ _tag: "Accepted", position: { seq: 1 } })

    const first = await append(firstPayload)
    expect(first).toMatchObject({
      result: {
        structuredContent: {
          output: firstPayload,
          position: { shard, epoch: 0, seq: 2 },
          journalSeq: 2,
          outputRef: "out/run-2",
          cause: { outputRef: "out/run-2", journalSeq: 2 }
        }
      }
    })
    expect(await append(firstPayload)).toEqual(first)
    expect(await append({ value: "conflict" })).toMatchObject({
      result: { isError: true, structuredContent: { code: "operation_failed", cause: "shard_commit_refused" } }
    })
    expect(await cause("out/run-2")).toMatchObject({
      result: {
        structuredContent: {
          cursor: "2",
          rows: [first.result.structuredContent.cause]
        }
      }
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
      result: {
        structuredContent: {
          cursor: "3",
          rows: [first.result.structuredContent.cause]
        }
      }
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
    const request = (host: string, origin?: string) =>
      new Promise<number | undefined>((resolve, reject) => {
        const outgoing = httpRequest(new URL("/mcp", node.origin), {
          method: "POST",
          headers: { ...headers(token), host, ...(origin === undefined ? {} : { origin }) }
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
        const outgoing = httpRequest(
          new URL("/mcp", node.origin),
          { method: "POST", headers: headers(token) },
          (response) => {
            response.setEncoding("utf8")
            let body = ""
            response.on("data", (text) => {
              body += text
            })
            response.once("end", () => {
              resolve({ status: response.statusCode, body })
              outgoing.destroy()
            })
            response.once("error", reject)
          }
        )
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

test.each(["SMITHERS_HUB_AGENT_TOKEN", "SMITHERS_HUB_TOKEN", "SMITHERS_TOKEN"])(
  "node serve refuses unbound or mismatched hub origins for %s before opening the node",
  { timeout: 30_000 },
  async (tokenName) => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-hub-binding-"))
    const file = join(dir, "node.sqlite")
    let requests = 0
    const server = createServer((_request, response) => {
      requests++
      response.writeHead(500).end()
    })
    try {
      server.listen(0, "127.0.0.1")
      await once(server, "listening")
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("Expected loopback listener")
      const hub = `http://127.0.0.1:${address.port}`
      for (
        const [approved, message] of [
          ["", "Hub replication requires SMITHERS_HUB_ORIGIN"],
          ["https://APPROVED.example:443/", "--hub must match SMITHERS_HUB_ORIGIN"]
        ]
      ) {
        const cli = makeCli({
          environment: {
            SMITHERS_NODE_AGENT_TOKEN: token,
            [tokenName]: replicationToken,
            SMITHERS_HUB_ORIGIN: approved
          }
        })
        let output = ""
        const exitCodes: Array<number | undefined> = []
        await cli.serve(["node", "serve", "--file", file, "--shard", shard, "--node", "replica", "--hub", hub], {
          stdout: (chunk) => {
            output += chunk
          },
          exit: (code) => {
            exitCodes.push(code)
          }
        })
        expect(exitCodes).toEqual([1])
        expect(output).toContain(message)
        expect(existsSync(file)).toBe(false)
        expect(requests).toBe(0)
      }
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

test(
  "the top-level CLI serves a loopback node and invokes the attach claim endpoint",
  { timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-node-cli-"))
    const server = createServer((request, response) => {
      claims.push([request.method, request.url])
      request.resume()
      response.writeHead(409).end()
    })
    const claims: Array<unknown> = []
    const environment = {
      ...process.env,
      HOME: dir,
      SMITHERS_DELEGATE_ACT: "agent",
      SMITHERS_NODE_AGENT_TOKEN: token,
      SMITHERS_NODE_SYNC_TOKEN: syncToken
    }
    const runCli = (...args: Array<string>) => {
      const child = spawn(process.execPath, ["--no-warnings", "--import", scriptedHost, executable, ...args], {
        cwd: dir,
        env: environment,
        stdio: "pipe",
        timeout: 30_000,
        killSignal: "SIGKILL"
      })
      let output = ""
      const capture = (chunk: Buffer) => {
        output += chunk.toString()
      }
      child.stderr.on("data", capture)
      child.stdout.on("data", capture)
      return { child, output: () => output, closed: once(child, "close") }
    }
    try {
      for (
        const [args, description] of [
          [["attach", "--help"], "one-time intent"],
          [["node", "serve", "--help"], "local SQLite shard"]
        ] as const
      ) {
        const help = runIn(dir, args)
        expect(help.status, help.stderr).toBe(0)
        expect(help.stdout).toContain(description)
      }
      server.listen(0, "127.0.0.1")
      await once(server, "listening")
      const addr = server.address()
      if (addr === null || typeof addr === "string") throw new Error("Expected loopback listener")
      const attached = runCli("attach", "--intent", "ABCD-1234", "--origin", `http://127.0.0.1:${addr.port}`)
      expect((await attached.closed)[0]).not.toBe(0)
      expect(attached.output()).toContain("HTTP 409")
      expect(claims).toEqual([["POST", "/api/attach/claim"]])

      Object.assign(environment, {
        SMITHERS_HUB_ORIGIN: `http://127.0.0.1:${addr.port}/`,
        SMITHERS_HUB_AGENT_TOKEN: replicationToken
      })
      const node = runCli(
        "node",
        "serve",
        "--file",
        join(dir, "node.sqlite"),
        "--shard",
        shard,
        "--node",
        "local",
        "--hub",
        `http://127.0.0.1:${addr.port}`
      )
      try {
        const origin = await new Promise<string>((resolve, reject) => {
          node.child.stderr.on("data", () => {
            const found = /Smithers node listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(node.output())
            if (found) resolve(found[1]!)
          })
          void node.closed.then(() => reject(new Error(node.output())), reject)
        })
        const response = await fetch(new URL(snapshot(), origin), { headers: headers(syncToken) })
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ position: { shard, seq: 0 } })
        const listed = await fetch(new URL("/mcp", origin), {
          method: "POST",
          headers: headers(token),
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
        })
        const catalog = await listed.json() as { result: { tools: ReadonlyArray<{ name: string }> } }
        expect(catalog.result.tools.map((tool) => tool.name)).toEqual(["ref__cause", "shard__append"])
      } finally {
        node.child.kill("SIGTERM")
        await node.closed
      }
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
