/** Actual canonical file -> native SQLite host -> RPC receipt and finalOutput. No model or external service. */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { ControlRpcs } from "@smthrs/control"
import { GatewayRpcs } from "@smthrs/gateway/GatewayRpcs"
import { Cause, Context, Deferred, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as HttpServer from "effect/unstable/http/HttpServer"
import * as NetAddress from "effect/unstable/net/NetAddress"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import * as Serve from "../../packages/smithers/src/Serve.ts"
import { layer } from "../invoke/host.ts"
import { registerPinnedLibraries } from "../invoke/serve.ts"

const declaration = `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("echo", {
 description: "Echo a pinned public invocation.", capabilities: [],
 effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
 payload: { value: Schema.String }, success: Schema.Struct({ value: Schema.String }),
 body: ({ value }) => Node.succeed({ value })
})
`

const phase = async (root: string, stateRoot: string, restart: boolean, source = declaration) => {
  if (process.versions.bun) registerPinnedLibraries(root, stateRoot)
  const { platform } = process.versions.bun
    ? await import("../../packages/smithers/src/internal/BunControl.ts")
    : await import("../../packages/smithers/src/internal/NodeControlHost.ts")
  const credential = "local-invoke-fixture", digest = createHash("sha256").update(source).digest("hex")
  let intent: any, runId = ""
  if (restart) {
    ;({ intent, runId } = JSON.parse(await readFile(join(stateRoot, "fixture-receipt.json"), "utf8")))
  }
  {
    const listening = Deferred.makeUnsafe<number>()
    const observed = {
      ...platform,
      evaluator: ScriptedJudge.layer,
      gateway: (health: any, options: any) =>
        platform.gateway(health, options).pipe(Layer.tap((context) => {
          const server = Context.get(context, HttpServer.HttpServer)
          if (!NetAddress.isInetAddress(server.address)) throw new Error("expected loopback TCP server")
          return Deferred.succeed(listening, server.address.port)
        }))
    }
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.forkScoped(
          Serve.host({ host: "127.0.0.1", port: 0, listen: false, credential }, root).pipe(
            Effect.tapCause((cause) => Effect.sync(() => console.error(Cause.pretty(cause))))
          )
        )
        const port = yield* Deferred.await(listening).pipe(Effect.timeout("30 seconds"))
        const mount = (path: string, bearer = credential) =>
          Layer.build(
            RpcClient.layerProtocolHttp({
              url: `http://127.0.0.1:${port}${path}`,
              transformClient: (client) => HttpClient.mapRequest(client, HttpClientRequest.bearerToken(bearer))
            }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]))
          )
        const control = yield* RpcClient.make(ControlRpcs.ControlRpcs).pipe(Effect.provide(yield* mount("/rpc")))
        const projection = yield* RpcClient.make(GatewayRpcs).pipe(Effect.provide(yield* mount("/projections")))
        if (!restart) {
          const unauthorized = yield* RpcClient.make(ControlRpcs.ControlRpcs).pipe(
            Effect.provide(yield* mount("/rpc", "wrong-credential"))
          )
          const denied = yield* Effect.result(
            unauthorized.Plan({ flowId: "echo", input: { value: "forbidden" }, idempotencyKey: "denied-plan" })
          )
          assert.equal(denied._tag, "Failure")
          if (denied._tag === "Failure") assert.equal((denied.failure as any)._tag, "/control/Unauthorized")
          const plan = yield* control.Plan({
            flowId: "echo",
            input: { value: "native-result" },
            idempotencyKey: "workflow-invoke:42:plan"
          })
          yield* projection["Approval.Submit"]({ ...plan.approval, decision: "approve" })
          intent = {
            _tag: "Plan",
            planId: plan.planId,
            digest: plan.digest,
            envelope: plan.envelope,
            idempotencyKey: "workflow-invoke:42:run"
          }
        }
        const receipt = yield* control.Run(intent)
        assert.ok(["Accepted", "AlreadyApplied", "Terminal"].includes(receipt._tag))
        assert.ok("runId" in receipt && receipt.runId)
        if (restart) assert.equal(receipt.runId, runId)
        else {
          runId = receipt.runId!
          yield* Effect.promise(() =>
            writeFile(join(stateRoot, "fixture-receipt.json"), JSON.stringify({ intent, runId }))
          )
        }
        const completed = yield* Effect.gen(function*() {
          for (;;) {
            const snapshot: any = yield* projection["Projection.Snapshot"]({ selector: { _tag: "run-summary", runId } })
            const row = snapshot.rows[0]
            if (row?.status === "failed" || (row?.status === "completed" && row?.finalOutput !== undefined)) return row
            yield* Effect.sleep("50 millis")
          }
        }).pipe(Effect.timeout("30 seconds"))
        assert.equal(completed.status, "completed", JSON.stringify(completed))
        assert.deepEqual(JSON.parse(completed.finalOutput), { value: "native-result" })
        const listed = yield* control.List({ _tag: "runs", filters: { flowId: "echo" } })
        assert.equal(listed._tag, "runs")
        if (listed._tag === "runs") assert.equal(listed.items.length, 1)
      }).pipe(
        Effect.provide(
          layer(observed, {
            root,
            stateRoot,
            flow: "echo",
            sourceDigest: digest,
            credential,
            evaluator: ScriptedJudge.layer
          })
        ),
        Effect.scoped
      )
    )
  }
  console.log(JSON.stringify({ runId, restart, completed: true }))
}

if (process.argv[2] === "--fixture") {
  await phase(
    process.argv[3]!,
    process.argv[4]!,
    process.argv[5] === "restart",
    process.argv[5] === "mismatch" ? declaration.replace("Flow.make(\"echo\"", "Flow.make(\"other\"") : declaration
  )
} else {
  test(
    "canonical invocation completes on the real native host and replays its retained receipt after process restart",
    { timeout: 120_000 },
    async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), "invoke-native-host-")),
        root = join(temporary, "repo"),
        stateRoot = join(temporary, "state")
      t.after(() => rm(temporary, { recursive: true, force: true }))
      await mkdir(join(root, "flows", "echo"), { recursive: true })
      await mkdir(stateRoot)
      await writeFile(join(root, "flows", "echo", "flow.ts"), declaration)
      const execute = promisify(execFile), results = []
      for (const mode of ["first", "restart"]) {
        const result = await execute(process.execPath, [
          fileURLToPath(import.meta.url),
          "--fixture",
          root,
          stateRoot,
          mode
        ], { timeout: 55_000, maxBuffer: 1024 * 1024 })
        const line = result.stdout.trim().split("\n").findLast((line) => line.startsWith("{\"runId\""))
        assert.ok(line, result.stdout + result.stderr)
        results.push(JSON.parse(line))
      }
      assert.equal(results[0].runId, results[1].runId)
      assert.deepEqual(results.map((r) => r.completed), [true, true])
    }
  )

  test("canonical invocation refuses a declared tag that differs from its path", { timeout: 30_000 }, async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), "invoke-tag-refusal-")),
      root = join(temporary, "repo"),
      stateRoot = join(temporary, "state")
    t.after(() => rm(temporary, { recursive: true, force: true }))
    await mkdir(join(root, "flows", "echo"), { recursive: true })
    await mkdir(stateRoot)
    await writeFile(
      join(root, "flows", "echo", "flow.ts"),
      declaration.replace("Flow.make(\"echo\"", "Flow.make(\"other\"")
    )
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [fileURLToPath(import.meta.url), "--fixture", root, stateRoot, "mismatch"],
        { timeout: 25_000, maxBuffer: 1024 * 1024 }
      ),
      /Flow.make tag must match/
    )
  })
}
