import * as Cloudflare from "@alchemy.run/cloudflare"
import { CauseReceipt, CliAdapter, GuiAdapter, McpAdapter, Principal, SdkAdapter } from "@smthrs/app-core"
import { canonicalHash, emptyPlanTree, PlanTree } from "@smthrs/app-state"
import { JournalCollection } from "@smthrs/effect-tanstack-db"
import { DoSqliteShard } from "@smthrs/platform-cloudflare"
import { ShardClient, ShardProtocol } from "@smthrs/sync"
import * as Output from "alchemy/Output"
import { ConfigProvider, Context, Effect, Layer, Option, Queue, Redacted, Schema, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import * as Reactivity from "effect/reactivity/Reactivity"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { openStorage } from "../../../../packages/smithers/flows/platform-cloudflare/test/SqliteObjectFixture.ts"
import { DEVICE_PERSON_HEADER, NO_DEVICE_DATA } from "../../src/features/auth/contract.ts"
import { type Actor, Sessions } from "../Actor.vibe"
import { MAX_PLAN_MCP_BYTES } from "../Body.vibe"
import { repositoryOf } from "../github/Config.vibe"
import * as RepoRoles from "../github/RepoRoles.vibe"
import { signedIn } from "../test/harness.ts"
import * as Plan from "./PlanTreeShard.vibe"
import * as Routes from "./PlanTreeRoutes.vibe"

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
      expect(Routes.handles("/api/repos/example/project/plan/summary")).toBe(false)
      expect((yield* route("/api/plan/summary", "other")).status).toBe(403)
      const aggregate = HttpServerResponse.toWeb(yield* route("/api/plan/summary", "reader"))
      expect(yield* Effect.promise(() => aggregate.json())).toEqual({ openPlanNodes: 1, waitingPlanNodes: 0 })

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
      expect(yield* Effect.flip(sdk.call(Plan.update, { command: {} }))).toMatchObject({ code: "invalid_command" })
      expect(yield* Effect.flip(sdk.call(Plan.update, {
        command: { _tag: "MovePlanNode", id: "absent", newParent: null, order: 0, expectedRevision: null },
      }))).toMatchObject({ code: "invalid_command" })
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

test("plan routes reject malformed requests and acknowledge MCP notifications", async () => {
  const db = openStorage(":memory:")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const plan = yield* Plan.make(db.storage, shard, auth())
      const fetch = yield* Routes.makeShardHandler(db.storage, shard)
      const request = (path: string, init?: RequestInit) =>
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request("https://smithers.example" + path, init)),
        )
      const headers = { authorization: "Bearer reader" }
      const body = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
      expect(Routes.handles("/api/repos/example/project/plan/mcp")).toBe(true)
      expect(Routes.handles("/api/repos/example/project/plan/other")).toBe(false)
      expect((yield* Routes.handle(plan).pipe(request("/api/plan/snapshot"))).status).toBe(401)
      expect((yield* Routes.handle(plan).pipe(request("/api/plan/other", { headers }))).status).toBe(404)
      expect((yield* Routes.handle(plan).pipe(request("/api/plan/snapshot", { headers }))).status).toBe(400)
      expect((yield* Routes.handle(plan).pipe(request("/api/plan/mcp", { headers, method: "POST", body }))).status).toBe(202)
      expect((yield* fetch.pipe(request("/api/plan/snapshot", { headers }))).status).toBe(403)
      expect(Plan.apply(emptyPlanTree, {
        _tag: "Reset",
        snapshot: { position: { shard, epoch: 0, seq: 0 }, state: null },
      })).toEqual(emptyPlanTree)
    }).pipe(Effect.provide(Reactivity.layer))))
  } finally {
    db.hibernate()
  }
})

test("repository plan dispatch rejects before forwarding and maps upstream failure", async () => {
  const repo = repositoryOf("example/project")
  const person = { subject: { kind: "person", id: "person" }, role: "admin" } as const
  const role = { repository: repo, resolve: () => Effect.succeed({ role: "maintainer" as const, held: Option.none() }) }
  const deniedRole = { ...role, resolve: () => Effect.fail(new RepoRoles.RoleRefused({ code: "unavailable", stage: "database" })) }
  const ordinaryPath = "/api/repos/example/project/plan/mcp"
  const route = (path: string, { actor = person as Actor, roles = role as RepoRoles.RepoRoles, body, anonymous = false }: {
    actor?: Actor
    roles?: RepoRoles.RepoRoles
    body?: string | Uint8Array<ArrayBuffer>
    anonymous?: boolean
  } = {}) => Routes.dispatch(() => Effect.fail("shard down"), roles, { admins: new Set() }).pipe(
    Effect.provideService(Sessions, Sessions.of({ resolve: Effect.succeed(anonymous ? Option.none() : Option.some(actor)) })),
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(
      "https://smithers.example" + path, body === undefined ? {} : { method: "POST", body },
    ))),
  )
  const status = async (program: ReturnType<typeof route>) => (await Effect.runPromise(program)).status
  expect(await status(route("/api/invalid"))).toBe(404)
  expect(await status(route(ordinaryPath, { anonymous: true }))).toBe(401)
  expect(await status(route("/api/repos/smithersai/smithers-ops/plan/mcp"))).toBe(404)
  expect(await status(route(ordinaryPath, { roles: deniedRole }))).toBe(403)
  expect(await status(route(ordinaryPath, { actor: { ...person, act: { kind: "agent", id: "run", ceiling: [] } } }))).toBe(403)
  expect(await status(route(ordinaryPath, { body: "a".repeat(MAX_PLAN_MCP_BYTES + 1) }))).toBe(413)
  expect(await status(route(ordinaryPath, { body: Uint8Array.of(0xff) }))).toBe(400)
  expect(await status(route(ordinaryPath))).toBe(503)
})

test("the live Plan Tree object initializes its fetch handler with the named SQLite shard", async () => {
  const db = openStorage(":memory:")
  let registered: unknown
  const worker = {
    bind: () => () => Effect.void,
    export: (name: string, value: unknown) => Effect.sync(() => {
      expect(name).toBe("PlanTreeObject")
      registered = value
    }),
    durableObjectNamespaces: Output.asOutput({}),
  } as unknown as Cloudflare.Worker
  const workerContext = Cloudflare.Worker.Self as unknown as Context.Key<Cloudflare.Worker, Cloudflare.Worker>
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* Layer.build(Routes.live).pipe(
        Effect.provideService(workerContext, worker),
        Effect.provideService(Cloudflare.WorkerEnvironment, { PlanTreeObject: { getByName: () => undefined } }),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" })),
      )
      expect(registered).toMatchObject({ kind: "durableObject" })
      const { constructor } = registered as {
        constructor: Effect.Effect<
          Effect.Effect<{ fetch: ReturnType<typeof Routes.handle> }, never, import("effect/Scope").Scope>,
          never, Cloudflare.DurableObjectState
        >
      }
      const state = {
        raw: { storage: db.storage, id: { name: shard } },
      } as unknown as Cloudflare.DurableObjectState["Service"]
      const initialize = yield* constructor.pipe(Effect.provideService(Cloudflare.DurableObjectState, state))
      const { fetch } = yield* initialize
      const response = yield* fetch.pipe(Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request("https://plan.internal/api/plan/snapshot")),
      ))
      expect(response.status).toBe(403)
    })))
  } finally {
    db.hibernate()
  }
})

test("a resync without a snapshot restores an empty plan and a conflicting journal receipt cannot publish state", async () => {
  const db = openStorage(":memory:")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { shard: journal } = yield* DoSqliteShard.make(db.storage, {
        shard,
        decide: () => ({ _tag: "Refused", reason: "fixture reservation" }),
      })
      const head = yield* journal.advanceEpoch
      const stream = Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard)
      const reserved = yield* journal.submit({
        version: 2, shard, epoch: head.epoch, command: { key: ["plan", "run-1"], stream, payload: null },
      })
      expect(reserved._tag).toBe("Refused")
      const hub = yield* Plan.make(db.storage, shard, auth())
      const sdk = yield* SdkAdapter.make({ engine: hub.engine, evidence: { kind: "sdk", runCredential: Redacted.make("sdk") } })
      expect((yield* hub.state).tree).toEqual(emptyPlanTree)
      const failed = yield* Effect.exit(sdk.call(Plan.update, command("must-not-publish")))
      expect(failed).toMatchObject({ _tag: "Failure" })
      expect((yield* hub.state).tree).toEqual(emptyPlanTree)
    }).pipe(Effect.provide(Reactivity.layer))))
  } finally {
    db.hibernate()
  }
})

test("a repeated artifact attachment cannot append an empty journal event", async () => {
  const db = openStorage(":memory:")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const hub = yield* Plan.make(db.storage, shard, auth())
      const sdk = yield* SdkAdapter.make({ engine: hub.engine, evidence: { kind: "sdk", runCredential: Redacted.make("sdk") } })
      yield* sdk.call(Plan.update, command("artifact-target"))
      const attach = { command: { _tag: "AttachArtifact", nodeId: "artifact-target", artifactId: "artifact", expectedRevision: null } }
      yield* sdk.call(Plan.update, attach)
      expect(yield* Effect.flip(sdk.call(Plan.update, attach))).toMatchObject({ code: "invalid_event_count" })
      expect((yield* hub.state).tree.nodes["artifact-target"]?.artifactIds).toEqual(["artifact"])
    }).pipe(Effect.provide(Reactivity.layer))))
  } finally {
    db.hibernate()
  }
})

test("plan/update enforces durable SQLite idempotency across retries, restarts, conflicts, and actor isolation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-idem-"))
  const path = join(dir, "plan.sqlite")
  let db = openStorage(path)
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      let hub = yield* Plan.make(db.storage, shard, auth())
      const mcp = yield* hub.engine.openMcp({ transport: "http", tokenRef: "mcp" })
      const createAt0 = {
        command: {
          _tag: "UpsertPlanNode" as const,
          id: "goal-1",
          parent: null,
          title: "Cutover milestone",
          milestone: "M0" as const,
          sources: ["docs/features/workbench.md"],
          assumptions: ["Real shard contract"],
          dodFast: "pnpm test",
          order: 0,
          expectedRevision: 0,
        },
        idempotencyKey: "cutover-goal-1",
      }

      const first = yield* mcp.submit({ operation: Plan.update, payload: createAt0 })
      expect(first.journalSeq).toBe(1)
      expect((yield* hub.state).tree.revision).toBe(1)

      // Exact retry after revision moved to 1 returns the original receipt without duplicating or failing revision_mismatch.
      const retry = yield* mcp.submit({ operation: Plan.update, payload: createAt0 })
      expect(retry).toEqual(first)
      expect((yield* hub.state).tree.revision).toBe(1)

      // Different command reusing the same key fails with idempotency_conflict.
      const conflicting = {
        ...createAt0,
        command: { ...createAt0.command, title: "Different title" },
      }
      expect(yield* Effect.flip(mcp.submit({ operation: Plan.update, payload: conflicting }))).toMatchObject({
        code: "idempotency_conflict",
      })
      expect((yield* hub.state).tree.revision).toBe(1)
      expect((yield* hub.state).tree.nodes["goal-1"]?.title).toBe("Cutover milestone")

      // Malformed idempotency key is refused cleanly.
      expect(yield* Effect.flip(mcp.submit({
        operation: Plan.update,
        payload: { ...createAt0, idempotencyKey: "bad key with spaces!" },
      }))).toMatchObject({ code: "invalid_idempotency_key" })

      // Survives Durable Object hibernation/restart from SQLite.
      db.hibernate()
      db = openStorage(path)
      hub = yield* Plan.make(db.storage, shard, auth())
      const reopenedMcp = yield* hub.engine.openMcp({ transport: "http", tokenRef: "mcp" })
      const retryAfterRestart = yield* reopenedMcp.submit({ operation: Plan.update, payload: createAt0 })
      expect(retryAfterRestart).toEqual(first)
      expect((yield* hub.state).tree.revision).toBe(1)

      // Snapshot and pull responses carry cache-control: no-store so browser reloads never see stale data.
      const snapRes = yield* Routes.handle(hub).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`https://smithers.example/api/plan/snapshot?shard=${encodeURIComponent(shard)}`, {
              headers: { authorization: "Bearer reader" },
            }),
          ),
        ),
      )
      expect(snapRes.status).toBe(200)
      expect(snapRes.headers["cache-control"]).toBe("no-store")
      const pullRes = yield* Routes.handle(hub).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(
              `https://smithers.example/api/plan/pull?${ShardProtocol.pullQuery({ version: 2, shard, epoch: 0, after: 0, limit: 10 })}`,
              { headers: { authorization: "Bearer reader" } },
            ),
          ),
        ),
      )
      expect(pullRes.status).toBe(200)
      expect(pullRes.headers["cache-control"]).toBe("no-store")

      // A different caller subject does not collide with another principal's idempotency key.
      const reopenedWriter = yield* hub.engine.openMcp({ transport: "http", tokenRef: "writer" })
      const second = yield* reopenedWriter.submit({
        operation: Plan.update,
        payload: {
          command: {
            _tag: "SetNodeStatus" as const,
            nodeId: "goal-1",
            status: "in_progress" as const,
            expectedRevision: 1,
          },
          idempotencyKey: "other-key",
        },
      })
      expect(second.journalSeq).toBe(2)
      expect((yield* hub.state).tree.nodes["goal-1"]?.status).toBe("in_progress")
      const personDoor = yield* hub.engine.openPerson({ session: "person" })
      const finished = yield* personDoor.submit({
        operation: Plan.review,
        payload: {
          command: { _tag: "SetNodeStatus" as const, nodeId: "goal-1", status: "done" as const, expectedRevision: 2 },
          idempotencyKey: "person-approve-1",
        },
      })
      expect(yield* personDoor.submit({
        operation: Plan.review,
        payload: {
          command: { _tag: "SetNodeStatus" as const, nodeId: "goal-1", status: "done" as const, expectedRevision: 2 },
          idempotencyKey: "person-approve-1",
        },
      })).toEqual(finished)
      expect((yield* hub.state).tree.nodes["goal-1"]?.status).toBe("done")
    }).pipe(Effect.provide(Reactivity.layer))))
  } finally {
    db.hibernate()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the projects summary counts outstanding plan items and decisions after reopening the shard", async () => {
  const db = openStorage(":memory:")
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const project = yield* Plan.make(db.storage, shard, auth())
      const writer = yield* project.engine.openMcp({ transport: "http", tokenRef: "writer" })
      expect(yield* project.summary).toEqual({ openPlanNodes: 0, waitingPlanNodes: 0 })
      for (const id of ["decision", "working", "finished"]) {
        yield* writer.submit({ operation: Plan.update, payload: command(id) })
      }
      for (const [nodeId, status] of [["decision", "blocked_on_will"], ["working", "in_progress"]] as const) {
        yield* writer.submit({ operation: Plan.update, payload: {
          command: { _tag: "SetNodeStatus", nodeId, status, expectedRevision: null },
        } })
      }
      const person = yield* project.engine.openPerson({ session: "person" })
      yield* person.submit({ operation: Plan.review, payload: {
        command: { _tag: "SetNodeStatus", nodeId: "finished", status: "done", expectedRevision: null },
      } })
      expect(yield* project.summary).toEqual({ openPlanNodes: 2, waitingPlanNodes: 1 })
      yield* project.compact
      const reopened = yield* Plan.make(db.storage, shard, auth())
      expect(yield* reopened.summary).toEqual({ openPlanNodes: 2, waitingPlanNodes: 1 })
    }).pipe(Effect.provide(Reactivity.layer))))
  } finally {
    db.hibernate()
  }
})
