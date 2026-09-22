/**
 * The dispatched turn, driven the way a remote caller drives it.
 *
 * Nothing here reaches into the flow. The test starts the configured coding
 * host, serves it on loopback, and then does exactly what plue's gateway
 * client does: `Plan`, `Approve`, `Run` on `/rpc`, and `Projection.Snapshot`
 * on `/projections` for the run the receipt named. What it pins is the
 * contract that crosses the wire — the `coding/dispatch` executable exists in
 * the served catalog, the host advertises `coding-dispatch/v1`, the envelope's
 * input decodes, the result carries the assistant turns and the run id, and
 * that run id is the handle the served transcript projection answers to.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import * as Seat from "@smthrs/agent/Seat"
import { ControlRpcs } from "@smthrs/control"
import { GatewayRpcs } from "../../packages/smithers/gateway/src/GatewayRpcs.ts"
import * as Model from "@smthrs/model/Model"
import { ModelEvent } from "@smthrs/model/ModelEvent"
import { Cause, Context, Deferred, Effect, Layer, Schema, Stream } from "effect"
import * as HttpServer from "effect/unstable/http/HttpServer"
import * as NetAddress from "effect/unstable/net/NetAddress"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import type * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import * as Serve from "../../packages/smithers/src/Serve.ts"
import { layer } from "../coding/host.ts"
import { DispatchResult } from "../coding/dispatch.ts"

const source = process.env.PLUE_CODING_ADAPTER_SOURCE, exporter = process.env.PLUE_JJ_EXPORT_BINARY
const json = (value: unknown): Schema.Json => JSON.parse(JSON.stringify(value))
const credential = "fixture-key"
const answer = ["Reading greeting.mjs.", "It exports the constant `greeting`."]

/** One scripted seat, answering every resolution with the same cell. */
const scriptedSeats = () => {
  const model = Model.make({
    stream: () =>
      Stream.fromIterable([
        ModelEvent.TextStart({ type: "text-start", id: "cell" }),
        ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: `\`\`\`cell\nctx.done(${JSON.stringify({ messages: answer })})\n\`\`\`` }),
        ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
        ModelEvent.Settle({ type: "settle", stopReason: "stop" })
      ])
  })
  return {
    resolve: (id: string) =>
      Effect.succeed(Seat.make({
        id, modelId: "scripted", model, contextWindowTokens: 100_000,
        route: { prepare: () => Effect.succeed({ routeId: "fixture", protocolId: "fixture", method: "POST" as const,
          url: "https://fixture.invalid", publicHeaders: {}, body: new TextEncoder().encode("{}"), bodyText: "{}" }) }
      }))
  }
}

test("a remote caller plans, runs and then reads one dispatched turn over the served gateway", {
  skip: source === undefined || exporter === undefined ? "Set PLUE_CODING_ADAPTER_SOURCE and PLUE_JJ_EXPORT_BINARY to Plue's native artifacts" : false,
  timeout: 300_000
}, async (t) => {
  const { platform } = await import("../../packages/smithers/src/internal/NodeControlHost.ts")
  const temporary = await mkdtemp(join(tmpdir(), "coding-dispatch-host-")), root = join(temporary, "repo")
  let passed = false
  t.diagnostic(`Dispatch host evidence: ${temporary}`)
  t.after(() => passed ? rm(temporary, { recursive: true, force: true }) : Promise.resolve())
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  const jj = (...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  jj("config", "set", "--repo", "user.name", "Dispatch test")
  jj("config", "set", "--repo", "user.email", "dispatch@example.com")
  await writeFile(join(root, ".gitignore"), "node_modules\n.flows/\n")
  await writeFile(join(root, "greeting.mjs"), "export const greeting = 'hello';\n")
  await mkdir(join(root, "node_modules/@smthrs"), { recursive: true })
  await symlink(fileURLToPath(new URL("../../packages/smithers/flows/core", import.meta.url)), join(root, "node_modules/@smthrs/core"))
  await symlink(fileURLToPath(new URL("../../node_modules/effect", import.meta.url)), join(root, "node_modules/effect"))
  jj("status")

  const config = join(temporary, "binding.json"), reporter = join(temporary, "reporter")
  const adapter = join(temporary, "adapter.py"), nativeSource = join(temporary, "native.py")
  await writeFile(config, JSON.stringify({ version: 1, workspaceId: "host-dispatch", actorId: 42, repositoryPath: root, username: userInfo().username }))
  await writeFile(reporter, 'exec 9>"$op_repo/smithers-coding.lock"')
  await writeFile(nativeSource, (await readFile(source!, "utf8")).replace('"/usr/local/bin/smithers-jj-export"', JSON.stringify(exporter)))
  await writeFile(adapter, `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("coding",${JSON.stringify(nativeSource)})\ncoding=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(coding)\ncoding.REPORTER_SCRIPT=${JSON.stringify(reporter)}\ntry:\n print(json.dumps(coding.run_local(${JSON.stringify(config)}, engine="--engine" in sys.argv)))\nexcept coding.CodingError as error:\n print(json.dumps({"error":{"code":error.code,"message":error.message}}))\n sys.exit(1)\n`)

  const listening = await Effect.runPromise(Deferred.make<number>())
  const observed: NativeControl.Platform = { ...platform, gateway: (health, options) =>
    platform.gateway(health, options).pipe(Layer.tap(context => {
      const server = Context.get(context, HttpServer.HttpServer)
      if (!NetAddress.isInetAddress(server.address)) throw new Error("expected TCP gateway")
      return Deferred.succeed(listening, server.address.port)
    })) }
  // No `planning`: a dispatched turn must be reachable on an ordinary
  // repository, which is exactly what coding/request is not.
  const hostLayer = layer(observed, { repositoryPath: root, adapterPath: adapter, sourcePublication: "local-only",
    exporterPath: exporter, gatewayId: "11111111-1111-4111-8111-111111111111", credential,
    implementationModel: "test:scripted", checkEnvironment: { PATH: process.env.PATH! } }, scriptedSeats())

  await Effect.runPromise(Effect.gen(function*() {
    yield* Effect.forkScoped(Serve.host({ host: "127.0.0.1", port: 0, listen: false, credential }, root).pipe(
      Effect.tapCause(cause => Effect.sync(() => t.diagnostic(Cause.pretty(cause))))))
    const port = yield* Deferred.await(listening).pipe(Effect.timeout("120 seconds"))
    const mount = (path: string) => Layer.build(RpcClient.layerProtocolHttp({ url: `http://127.0.0.1:${port}${path}`,
      transformClient: client => HttpClient.mapRequest(client, HttpClientRequest.bearerToken(credential)) })
      .pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson])))
    const control = yield* RpcClient.make(ControlRpcs.ControlRpcs).pipe(Effect.provide(yield* mount("/rpc")))
    const read = yield* RpcClient.make(GatewayRpcs).pipe(Effect.provide(yield* mount("/projections")))

    // The workspace advertises the door before anyone knocks on it.
    const health: any = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/health`).then(response => response.json()))
    assert.ok((health.capabilities as ReadonlyArray<string>).includes("coding-dispatch/v1"), JSON.stringify(health))
    const listed: any = yield* control.List({ _tag: "flows" })
    assert.ok((listed.items as ReadonlyArray<any>).some(item => item.flowId === "coding/dispatch"),
      (listed.items as ReadonlyArray<any>).map(item => item.flowId).join(","))

    const input = { turnId: "turn-remote", prompt: "What does greeting.mjs export?", role: "coding/dispatch",
      workspaceRoot: root, history: [{ role: "user", content: "Look at the repository." }] }
    const planned: any = yield* control.Plan({ flowId: "coding/dispatch", input: json(input), idempotencyKey: "dispatch:plan" })
    yield* control.Approve({ ...planned.approval, scope: "once" })
    const launched: any = yield* control.Run({ _tag: "Plan", planId: planned.planId, digest: planned.digest,
      envelope: planned.envelope, idempotencyKey: "dispatch:run" })
    assert.ok(["Accepted", "AlreadyApplied", "Terminal"].includes(launched._tag), JSON.stringify(launched))
    assert.ok(typeof launched.runId === "string" && launched.runId.length > 0, JSON.stringify(launched))

    // A caller streams the turn from the run the receipt named, which is the
    // same run the flow reports back in its own result.
    const runs: any = yield* control.List({ _tag: "runs", filters: { runId: launched.runId }, limit: 1 })
    assert.equal((runs.items as ReadonlyArray<any>).length, 1)
    const transcript: any = yield* read["Projection.Snapshot"]({ selector: { _tag: "transcript", runId: launched.runId } })
    assert.ok(Array.isArray(transcript.rows), JSON.stringify(transcript).slice(0, 400))

    const summary = yield* Effect.gen(function*() {
      while (true) {
        const projection: any = yield* read["Projection.Snapshot"]({ selector: { _tag: "run-summary", runId: launched.runId } })
        assert.deepEqual(projection.selector, { _tag: "run-summary", runId: launched.runId })
        assert.equal(projection.rows.length, 1)
        const row = projection.rows[0]
        assert.equal(row.runId, launched.runId)
        assert.equal(row.flowId, "coding/dispatch")
        if (["completed", "failed", "cancelled"].includes(row.status)) return row
        yield* Effect.sleep("100 millis")
      }
    }).pipe(Effect.timeout("120 seconds"))
    assert.equal(summary.status, "completed", JSON.stringify(summary))
    assert.equal(typeof summary.finalOutput, "string", "completed dispatch must retain its final output")
    const result = Schema.decodeUnknownSync(DispatchResult)(JSON.parse(summary.finalOutput))
    assert.equal(result.turnId, "turn-remote")
    assert.equal(result.runId, launched.runId)
    assert.deepEqual(result.messages.map(message => message.content), answer)

  }).pipe(Effect.provide(hostLayer), Effect.scoped))
  passed = true
})
