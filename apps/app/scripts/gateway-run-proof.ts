/*
 * The end-to-end proof: this app's own gateway seam drives a run.
 *
 * The script stands up
 *
 *   - a real workspace gateway (`@smthrs/gateway` over a real SQLite control
 *     plane, journal, and run store) on a loopback port, behind a bearer
 *     credential;
 *   - the product Worker's relay, using the Worker's own frame adapter
 *     (`smithers-server/gatewayRpc`), which holds the credential the browser
 *     cannot;
 *   - this app's seam (`createGatewaySeam`), unmodified, pointed at the relay,
 *
 * and then does what a human does: list the flows, launch one, watch it,
 * approve the gate it parks on, read what a node produced, and cancel it.
 *
 * What is real and what is scripted. The gateway, the relay, the seam, the
 * control plane, and every mutation are real: each step below is an HTTP call
 * that crosses all three. The run's own ACTIVITY is scripted: only an agent
 * run parks on a permission gate, an agent run needs a provider credential
 * (`ANTHROPIC_API_KEY` or another seat), and a proof that skipped without one
 * would prove nothing in the environments this is run in. So the turn, the
 * cell call, and the gate are journaled here with the exact payloads
 * `@smthrs/agent` `AgentSession` writes: `{seat, contextDigest}`,
 * `{flowName, input}`, `{flowName, outcome, message, value}`, and the
 * approval `AgentSession.authorize` registers. A run the durable engine really
 * executes is proven separately, in `packages/smithers/gateway/test/RealEngineRun.test.ts`.
 *
 * The load-bearing assertion is the approval: ONE call decides the gate and
 * resumes the run. The relay counts every procedure it forwards, so a second
 * `Resume` would be visible here and fails the proof.
 *
 * Run it with: bun apps/app/scripts/gateway-run-proof.ts
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlLive from "@smthrs/control/ControlLive"
import { Control } from "@smthrs/control/Control"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { ApprovalTarget } from "@smthrs/control/ControlSchema"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"
import * as GatewayProjections from "@smthrs/gateway/Projections"
import { Migrations, SqlJournal } from "@smthrs/journal"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Migrations as RunStoreMigrations, RunStore } from "@smthrs/run-store"
import * as RunCatalog from "@smthrs/sync/RunCatalog"
import * as SyncAuth from "@smthrs/sync/SyncAuth"
import * as SyncServer from "@smthrs/sync/SyncServer"
import * as WorkspaceShare from "@smthrs/sync/WorkspaceShare"
import { Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  decodeGatewayResponse,
  encodeGatewayRequest,
  GATEWAY_PROCEDURE_MOUNTS
} from "smithers-server/gatewayRpc"
import { createGatewaySeam } from "../src/mainview/state/controller/gateway"

const CREDENTIAL = "proof-bearer-credential"
const REPO = "codeplanesmithers/smithers-demo"

const check = (condition: boolean, what: string): void => {
  if (!condition) throw new Error(`FAILED: ${what}`)
  console.log(`  ok  ${what}`)
}

const directory = mkdtempSync(join(tmpdir(), "smithers-ui-proof-"))
const filename = join(directory, "control.db")

const storage = Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), RunStore.layer).pipe(
  Layer.provideMerge(
    Layer.provideMerge(
      Layer.merge(Migrations.layer, RunStoreMigrations.layer),
      Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
    )
  )
)

const workspace = Layer.mergeAll(GatewayProjections.layer, SyncServer.layer, SyncAuth.layer).pipe(
  Layer.provideMerge(Layer.merge(RunCatalog.layerNoop, WorkspaceShare.layerNoop)),
  Layer.provideMerge(ControlLive.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      SqlControlRuntime.layer({}).pipe(Layer.orDie),
      NotificationQueue.layer,
      ControlExecutor.layer(ControlExecutor.makeNoop()),
      Registry.layerNoop()
    )
  ),
  Layer.provideMerge(Layer.merge(storage, NodeCrypto.layer))
)

const served = NodeGateway.layer(
  { workspaceHash: "proof", gatewayId: "proof-gateway", protocolVersion: "1", version: "1.0.0-rc.0" },
  { host: "127.0.0.1", port: 0, credential: CREDENTIAL }
).pipe(Layer.provideMerge(workspace))

/** Every procedure the relay forwarded, so a second resume would be visible. */
const relayed: Array<string> = []

/** The product Worker's relay, with the Worker's own frame adapter. */
const startRelay = (gatewayUrl: string): Promise<{ url: string; close: () => void }> =>
  new Promise((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        void (async () => {
          const answer = (status: number, body: unknown): void => {
            response.writeHead(status, { "content-type": "application/json" })
            response.end(JSON.stringify(body))
          }
          const url = new URL(request.url ?? "/", "http://relay.local")
          if (url.pathname === "/api/workflow/provision") return answer(200, { status: "ready", repo: REPO })
          if (url.pathname !== "/api/workflow/rpc") return answer(404, { status: "error", message: "no route" })
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            repo: string
            procedure: string
            payload?: unknown
          }
          const mount = GATEWAY_PROCEDURE_MOUNTS[body.procedure]
          if (mount === undefined) {
            return answer(400, { status: "error", message: `The workflow seam does not relay ${body.procedure}.` })
          }
          relayed.push(body.procedure)
          const upstream = await fetch(`${gatewayUrl}${mount}`, {
            method: "POST",
            // The credential the browser can never hold.
            headers: { authorization: `Bearer ${CREDENTIAL}`, "content-type": "application/json" },
            body: encodeGatewayRequest(body.procedure, body.payload)
          })
          answer(200, decodeGatewayResponse(await upstream.text()))
        })()
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("no relay address")
      resolve({ url: `http://127.0.0.1:${address.port}`, close: () => server.close() })
    })
  })

const program = Effect.gen(function*() {
  const gateway = yield* HttpServer.HttpServer
  if (gateway.address._tag !== "TcpAddress") throw new Error("no gateway address")
  const gatewayUrl = `http://127.0.0.1:${gateway.address.port}`
  const relay = yield* Effect.promise(() => startRelay(gatewayUrl))
  yield* Effect.addFinalizer(() => Effect.sync(relay.close))

  // The app's own seam, unmodified, over the relay.
  const seam = createGatewaySeam({
    baseUrl: relay.url,
    fetch: (url, init) => fetch(url, init),
    errorMessageOf: async (response, fallback) => `${fallback} (HTTP ${response.status})`
  })

  console.log("\n1. the workspace's flows")
  const flows = yield* Effect.promise(() => seam.listFlows(REPO))
  check(flows.status === "ok", "the seam lists the workspace's flows")
  check(
    flows.status === "ok" && flows.value.some((flow) => flow.flowId === "system/test"),
    "the listing names a real flow"
  )

  console.log("\n2. launch")
  const launched = yield* Effect.promise(() => seam.launch(REPO, "system/test", { proof: true }))
  check(launched.status === "ok", "the seam launched a run")
  if (launched.status !== "ok") return
  const runId = launched.value.runId
  check(runId.length > 0, `the run is named: ${runId}`)

  console.log("\n3. watch")
  const watched = yield* Effect.promise(() => seam.run(REPO, runId))
  check(watched.status === "ok" && watched.value !== undefined, "the run reads back through the projection")
  check(
    watched.status === "ok" && watched.value?.flowId === "system/test",
    "the run carries the flow it was launched from"
  )
  check(
    watched.status === "ok" && typeof watched.value?.diagnosis === "string",
    "the run carries its diagnosis, which the old wire called whatHappened"
  )

  console.log("\n4. a node produces output, and the run parks on a gate")
  const journal = yield* Journal.Journal
  const runtime = yield* ControlRuntime
  let source = 0
  const emit = (eventType: string, payload: unknown) =>
    Effect.orDie(
      journal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(runId),
          sourceId: JournalEvent.SourceId.make("proof"),
          sourceSeq: JournalEvent.SourceSeq.make((source += 1)),
          eventType,
          payload: JSON.parse(JSON.stringify(payload))
        })
      )
    )
  yield* emit("control.agent.turn-opened", { seat: "proof-seat", contextDigest: "proof-context" })
  yield* emit("control.agent.cell-call-started", { flowName: "write", input: { path: "docs/proof.md" } })
  yield* emit("control.agent.cell-call-settled", {
    flowName: "write",
    outcome: "success",
    value: "wrote docs/proof.md"
  })
  const target: ApprovalTarget = {
    _tag: "Node",
    runId,
    requestId: "proof-gate",
    digest: "proof-digest",
    envelope: { capabilities: ["model:call"], flows: ["ask"], budget: {} }
  }
  // Exactly what `AgentSession.authorize` does when a run asks for a decision.
  yield* runtime.registerApproval(target)
  yield* emit("control.approval.requested", {
    runId,
    requestId: "proof-gate",
    question: "Open a pull request?",
    payload: { target, scope: "run", idempotencyKey: "approve:proof-gate" }
  })

  const gates = yield* Effect.promise(() => seam.approvals(REPO, runId))
  check(gates.status === "ok" && gates.value.length === 1, "the parked gate reaches the seam")
  if (gates.status !== "ok" || gates.value[0] === undefined) return
  const gate = gates.value[0]
  check(gate.title === "Open a pull request?", "the gate carries the question the run asked")

  console.log("\n5. approve: one call, no second resume")
  const before = relayed.length
  const decided = yield* Effect.promise(() => seam.submitApproval(REPO, gate.payload, "approve"))
  check(decided.status === "ok", "the decision was accepted")
  check(relayed.length === before + 1, "the decision was ONE relayed call")
  check(relayed.at(-1) === "Approval.Submit", "that call was Approval.Submit")
  check(!relayed.includes("Resume"), "no second manual resume was ever issued")
  const answer = decided.status === "ok" ? decided.value as { resume?: unknown } : undefined
  check(answer?.resume !== undefined, "the gateway resumed the run on the caller's behalf")

  console.log("\n6. node output")
  // The emitter names no node, so the projection keys a call by the ordinal it
  // opened on. `call-1` is this run's first call.
  const output = yield* Effect.promise(() => seam.nodeOutput(REPO, runId, "call-1"))
  check(output.status === "ok" && output.value !== undefined, "the node's output reaches the seam")
  check(
    output.status === "ok" && output.value?.output === "wrote docs/proof.md",
    "the output is what the node produced"
  )

  console.log("\n7. explain")
  const explained = yield* Effect.promise(() => seam.explain(REPO, runId))
  check(explained.status === "ok" && (explained.value ?? "").length > 0, "the run explains itself in one line")

  console.log("\n8. cancel")
  const cancelled = yield* Effect.promise(() => seam.cancel(REPO, runId))
  check(cancelled.status === "ok", "the cancel was accepted")
  const after = yield* Effect.promise(() => seam.run(REPO, runId))
  check(after.status === "ok" && after.value?.status === "cancelled", "the cancel is durable: the run reads cancelled")

  // The control plane and the seam agree, because there is only one of them.
  const control = yield* Control
  const listed = yield* control.list({ _tag: "runs", filters: { runId } })
  check(
    listed._tag === "runs" && listed.items[0]?.status === "cancelled",
    "the control plane itself says the same"
  )

  console.log(`\nRelayed procedures: ${relayed.join(", ")}`)
  console.log("\nPROOF PASSED")
}).pipe(Effect.provide(served), Effect.scoped)

Effect.runPromise(program).then(
  () => {
    rmSync(directory, { recursive: true, force: true })
    process.exit(0)
  },
  (error: unknown) => {
    rmSync(directory, { recursive: true, force: true })
    console.error(error)
    process.exit(1)
  }
)
