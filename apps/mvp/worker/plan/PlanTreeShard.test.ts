import { CauseReceipt, CliAdapter, GuiAdapter, McpAdapter, Principal, SdkAdapter } from "@smthrs/app-core"
import { canonicalHash, emptyPlanTree, PlanTree } from "@smthrs/app-state"
import { JournalCollection } from "@smthrs/effect-tanstack-db"
import { ShardClient, ShardProtocol } from "@smthrs/sync"
import { Effect, Option, Queue, Redacted, Schema, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import * as Reactivity from "effect/reactivity/Reactivity"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { openStorage } from "../../../../packages/smithers/flows/platform-cloudflare/test/SqliteObjectFixture.ts"
import { DEVICE_PERSON_HEADER, NO_DEVICE_DATA } from "../../src/features/auth/contract.ts"
import type { Actor } from "../Actor.ts"
import { repositoryOf } from "../github/Config.ts"
import { signedIn } from "../test/harness.ts"
import * as Plan from "./PlanTreeShard.ts"
import * as Routes from "./PlanTreeRoutes.ts"

const shard = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:example/project")
const other = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:example/other")
const capabilities = [Plan.readCapability(shard), Plan.writeCapability(shard)]
const auth = () => Principal.make({ verify: Principal.sessions({
  mcp: { kind: "mcp", subject: "p", session: "mcp", capabilities },
  empty: { kind: "mcp", subject: "p", session: "empty", capabilities: [] },
  reader: { kind: "mcp", subject: "p", session: "reader", capabilities: [Plan.readCapability(shard)] },
  writer: { kind: "mcp", subject: "p", session: "writer", capabilities: [Plan.writeCapability(shard)] },
  other: {
    kind: "mcp", subject: "p", session: "other", capabilities: [Plan.readCapability(other), Plan.writeCapability(other)]
  },
  cli: { kind: "incur", subject: "p", session: "cli", capabilities },
  sdk: { kind: "sdk", subject: "p", session: "sdk", capabilities },
  frame: { kind: "gui", door: "frame", plugin: "plan", subject: "p", session: "frame", capabilities },
  person: { kind: "gui", door: "person", subject: "p", session: "person", capabilities }
}, { plan: capabilities }) })
const command = (id: string) => ({ command: {
  _tag: "UpsertPlanNode", id, parent: null, title: id, milestone: "M0", sources: [], assumptions: [],
  dodFast: "", order: 0, expectedRevision: null
} })
const done = { command: { _tag: "SetNodeStatus", nodeId: "mcp", status: "done", expectedRevision: null } }
const Row = Schema.Struct({ id: Schema.String, state: PlanTree })

test("Plan Tree capabilities are explicit and the journal routes stay on the local shard", async () => {
  const db = openStorage(":memory:")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const hub = yield* Plan.make(db.storage, shard, auth())
      const open = (tokenRef: string) => hub.engine.openMcp({ transport: "http", tokenRef })
      const read = { query: Plan.read }
      const update = { operation: Plan.update, payload: command("scoped") }
      for (const token of ["empty", "other"]) {
        const refused = yield* open(token)
        expect(yield* Effect.flip(refused.read(read))).toMatchObject({ reason: "capability_exceeded" })
        expect(yield* Effect.flip(refused.submit(update))).toMatchObject({ reason: "capability_exceeded" })
      }
      const writer = yield* open("writer")
      const reader = yield* open("reader")
      expect(yield* Effect.flip(writer.read(read))).toMatchObject({ reason: "capability_exceeded" })
      expect(yield* Effect.flip(reader.submit(update))).toMatchObject({ reason: "capability_exceeded" })
      yield* writer.submit(update)
      expect(yield* reader.read(read)).toMatchObject({ rows: [{ revision: 1 }] })

      const route = (path: string, token: string) => Routes.handle(hub).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(
          new Request("https://smithers.example" + path, { headers: { authorization: "Bearer " + token } })
        ))
      )
      for (const requested of [shard, other]) {
        const paths = [
          "/api/plan/pull?" + ShardProtocol.pullQuery({ version: 2, shard: requested, epoch: 0, after: 0, limit: 10 }),
          "/api/plan/snapshot?" + new URLSearchParams({ shard: requested }),
        ]
        for (const path of paths) {
          expect((yield* route(path, "empty")).status).toBe(403)
          expect((yield* route(path, "writer")).status).toBe(403)
          expect((yield* route(path, "other")).status).toBe(403)
          expect((yield* route(path, "invalid")).status).toBe(401)
          expect((yield* route(path, "reader")).status).toBe(requested === shard ? 200 : 403)
        }
      }
    }).pipe(Effect.provide(Reactivity.layer))))
  } finally {
    db.hibernate()
  }
})

test("Plan MCP requires the shard read grant for live and restored cause receipts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-causes-"))
  const path = join(dir, "plan.sqlite")
  let db = openStorage(path)
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      let hub = yield* Plan.make(db.storage, shard, auth())
      const call = (token: string, name: string, args: unknown) => Routes.handle(hub).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(
          new Request("https://smithers.example/api/plan/mcp", {
            method: "POST",
            headers: { authorization: "Bearer " + token },
            body: JSON.stringify({
              jsonrpc: "2.0", id: 1, method: "tools/call",
              params: { name: McpAdapter.toolName(name), arguments: args }
            })
          })
        )),
        Effect.flatMap((response) => Effect.promise(() => HttpServerResponse.toWeb(response).json()))
      )
      const writer = yield* hub.engine.openMcp({ transport: "http", tokenRef: "writer" })
      const compacted = yield* writer.submit({ operation: Plan.update, payload: command("compacted") })
      yield* hub.compact
      const tail = yield* writer.submit({ operation: Plan.update, payload: command("tail") })
      const checkCauses = Effect.gen(function*() {
        for (const { cause, outputRef } of [compacted, tail]) {
          const params = { ref: outputRef }
          for (const token of ["empty", "other", "writer"]) {
            expect(yield* call(token, CauseReceipt.query, params)).toMatchObject({
              result: { isError: true, structuredContent: { code: "capability_exceeded" } }
            })
          }
          expect(yield* call("reader", CauseReceipt.query, params)).toMatchObject({
            result: { structuredContent: { rows: [cause] } }
          })
        }
      })
      yield* checkCauses
      db.hibernate()
      db = openStorage(path)
      hub = yield* Plan.make(db.storage, shard, auth())
      yield* checkCauses
    }).pipe(Effect.provide(Reactivity.layer))))
  } finally {
    db.hibernate()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Plan MCP decodes split UTF-8 and stops reading an oversized chunked body", async () => {
  const db = openStorage(":memory:")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const hub = yield* Plan.make(db.storage, shard, auth())
      const handle = (request: Request) => Routes.handle(hub).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request))
      )
      const path = "https://smithers.example/api/plan/mcp"
      const init = { method: "POST", headers: { authorization: "Bearer mcp" }, duplex: "half" as const }
      const encoded = new TextEncoder().encode(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: McpAdapter.toolName(Plan.update), arguments: command("café") }
      }))
      const split = encoded.indexOf(0xc3) + 1
      const splitRequest = new Request(path, { ...init, body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded.subarray(0, split))
          controller.enqueue(encoded.subarray(split))
          controller.close()
        }
      }) })
      expect((yield* handle(splitRequest)).status).toBe(200)
      expect((yield* hub.state).tree.nodes["café"]?.title).toBe("café")

      const chunk = new TextEncoder().encode("é".repeat(16_385))
      let cancelled = false
      const overflow = new Request(path, {
        ...init,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk)
            controller.enqueue(chunk)
          },
          cancel() { cancelled = true }
        })
      })
      expect(overflow.headers.has("content-length")).toBe(false)
      const response = yield* handle(overflow)
      expect(response.status).toBe(413)
      expect(cancelled).toBe(true)
    }).pipe(Effect.provide(Reactivity.layer))))
  } finally {
    db.hibernate()
  }
})

test("four clients and TanStack DB converge through a SQLite restart without a reset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-shard-"))
  const path = join(dir, "plan.sqlite")
  let db = openStorage(path)
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      let hub = yield* Plan.make(db.storage, shard, auth())
      const mcpEvidence = { kind: "mcp", transport: "stdio", tokenRef: "mcp" } as const
      const route = (path: string, init: RequestInit) => Routes.handle(hub).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request(`https://smithers.example${path}`, init))),
        Effect.map(HttpServerResponse.toWeb)
      )
      const call = (name: string, args: unknown) => route("/api/plan/mcp", {
        method: "POST",
        headers: { authorization: "Bearer mcp" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: McpAdapter.toolName(name), arguments: args }
        })
      }).pipe(Effect.flatMap((response) => Effect.promise(() => response.json())))
      expect((yield* route("/api/plan/mcp", { method: "POST", headers: { authorization: "Bearer invalid" } })).status)
        .toBe(401)
      const cli = yield* CliAdapter.make({ engine: hub.engine, evidence: { kind: "incur", sessionFile: "cli" } })
      const sdk = yield* SdkAdapter.make({
        engine: hub.engine, evidence: { kind: "sdk", runCredential: Redacted.make("sdk") }
      })
      const gui = yield* GuiAdapter.make({
        engine: hub.engine, frame: { session: "frame", plugin: "plan" }, person: { session: "person" }
      })
      const mcpReply = yield* call(Plan.update, command("mcp"))
      const { result: { structuredContent: { cause } } } = Schema.decodeUnknownSync(Schema.Struct({
        result: Schema.Struct({ structuredContent: Schema.Struct({ cause: CauseReceipt.CauseReceipt }) })
      }))(mcpReply)
      expect(cause.planRef).toEqual({ page: shard, blockId: "mcp", rev: "0" })
      expect(yield* cli.run([Plan.update, "--input-json", JSON.stringify(command("cli"))])).toMatchObject({ exitCode: 0 })
      yield* sdk.call(Plan.update, command("sdk"))
      yield* gui.actions.dispatch(Plan.update, command("gui"))
      expect(yield* Effect.flip(gui.actions.dispatch(Plan.review, done))).toMatchObject({ reason: "person_only" })
      expect(yield* Effect.flip(sdk.call(Plan.review, done))).toMatchObject({ reason: "person_only" })
      expect(yield* Effect.flip(sdk.call(Plan.update, done))).toMatchObject({ code: "wrong_operation" })
      yield* gui.hostStrip.press(Plan.review, done)
      const first = yield* hub.state
      expect(first.tree.nodes["mcp"]?.status).toBe("done")
      expect(first.tree.revision).toBe(5)
      const batches = yield* Queue.unbounded<JournalCollection.Batch<typeof Row.Type, string>>()
      yield* Queue.offer(batches, { snapshot: true, through: 0, changes: [{ type: "insert", value: { id: "tree", state: emptyPlanTree } }] })
      const collection = yield* JournalCollection.make({
        id: "plan-e2e", schema: Row, getKey: (row) => row.id,
        source: { batches: Stream.fromQueue(batches), submit: () => Effect.fail("read only") }
      })
      yield* collection.preload
      let projection = emptyPlanTree
      let resets = 0
      const client = yield* ShardClient.make({
        shard, node: "tanstack",
        transport: {
          submit: () => Effect.die("read only"),
          pull: (request) => hub.journal.pull(request),
          snapshot: (id) => hub.journal.snapshot(id)
        },
        store: ShardClient.memoryStore(),
        apply: (delivery) => Effect.gen(function*() {
          projection = Plan.apply(projection, delivery)
          if (delivery._tag === "Reset") resets++
          yield* Queue.offer(batches, {
            snapshot: false,
            through: delivery._tag === "Reset" ? delivery.snapshot.position.seq : delivery.through.seq,
            changes: [{ type: "update", value: { id: "tree", state: projection } }]
          })
        })
      })
      yield* client.pull
      expect(yield* hub.compact).toMatchObject({ seq: 5 })
      db.hibernate()
      db = openStorage(path)
      hub = yield* Plan.make(db.storage, shard, auth())
      expect(yield* hub.state).toEqual(first)
      const after = yield* hub.engine.openMcp(mcpEvidence)
      expect((yield* after.read({ query: "ref/cause", params: { ref: cause.outputRef } })).rows).toEqual([cause])
      yield* after.submit({ operation: Plan.update, payload: command("after") })
      expect(yield* client.pull).toMatchObject({ seq: 6 })
      expect(resets).toBe(0)
      const expected = (yield* hub.state).hash
      yield* Effect.gen(function*() {
        while (canonicalHash((yield* collection.toArray)[0]?.state ?? null) !== expected) yield* Effect.sleep(1)
      }).pipe(Effect.timeout(3000))
      const page = Schema.Struct({ rows: Schema.Array(PlanTree), cursor: Schema.String })
      const mcpPage = yield* call(Plan.read, {})
      const mcpRead = Schema.decodeUnknownSync(Schema.Struct({
        result: Schema.Struct({ structuredContent: page })
      }))(mcpPage).result.structuredContent
      const restartedCli = yield* CliAdapter.make({
        engine: hub.engine, evidence: { kind: "incur", sessionFile: "cli" }
      })
      const cliReply = yield* restartedCli.run([Plan.read])
      expect(cliReply.exitCode).toBe(0)
      const cliRead = Schema.decodeUnknownSync(page)(JSON.parse(cliReply.stdout))
      const restartedSdk = yield* SdkAdapter.make({
        engine: hub.engine, evidence: { kind: "sdk", runCredential: Redacted.make("sdk") }
      })
      const restartedGui = yield* GuiAdapter.make({
        engine: hub.engine, frame: { session: "frame", plugin: "plan" }, person: { session: "person" }
      })
      for (const [tag, result] of [
        ["mcp", mcpRead],
        ["cli", cliRead],
        ["sdk", yield* restartedSdk.read(Plan.read)],
        ["gui", yield* restartedGui.queries.read(Plan.read)]
      ] as const) {
        expect(canonicalHash(result.rows[0]), tag).toBe(expected)
      }
    }).pipe(Effect.provide(Reactivity.layer))))
  } finally {
    db.hibernate()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the repository route derives shard grants from the session and the repository role", async () => {
  const db = openStorage(":memory:")
  const repo = repositoryOf("example/project")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const fetch = yield* Routes.makeShardHandler(db.storage, shard)
      const person = { subject: { kind: "person", id: "person" }, role: "admin" } as const
      const routed = (actor: Actor, role: Actor["role"], path: string, body?: unknown) =>
        Routes.dispatch((id, request) => {
          expect(id).toBe(shard)
          return fetch.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
        }, {
          repository: repo,
          resolve: (_actor, requested) => {
            expect(requested.id).toBe(repo.id)
            return Effect.succeed({ role, held: Option.none() })
          },
        }, { admins: new Set() }).pipe(
          Effect.provide(signedIn(actor)),
          Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(
            `https://smithers.example/api/repos/example/project/plan/${path}`, {
              headers: {
                [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA,
                "x-smithers-plan-admission": JSON.stringify({ subject: "impostor", session: "fake", write: true }),
              },
              ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
            },
          ))),
        )
      const delegated = { ...person, act: { kind: "agent", id: "run", ceiling: [[Plan.readCapability(other)]] } } as const
      const snapshot = (requested: string) => "snapshot?" + new URLSearchParams({ shard: requested })
      const update = {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: McpAdapter.toolName(Plan.update), arguments: command("role-test") },
      }
      expect((yield* routed(person, "guest", snapshot(shard))).status).toBe(403)
      expect((yield* routed(delegated, "admin", snapshot(shard))).status).toBe(403)
      expect((yield* routed({
        ...delegated, act: { ...delegated.act, ceiling: [[Plan.readCapability(shard)]] },
      }, "member", snapshot(shard))).status).toBe(200)
      expect((yield* routed(person, "member", snapshot(other))).status).toBe(403)
      expect((yield* routed(person, "member", snapshot(shard))).status).toBe(200)
      const call = (role: "member" | "maintainer") => routed(person, role, "mcp", update).pipe(
        Effect.flatMap((response) => Effect.promise(() => HttpServerResponse.toWeb(response).json())),
      )
      expect(yield* call("member")).toMatchObject({ result: { isError: true } })
      expect(yield* call("maintainer")).toMatchObject({ result: { structuredContent: expect.any(Object) } })
    })))
  } finally {
    db.hibernate()
  }
})
