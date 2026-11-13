/**
 * The engine worker the suites' page starts: `BrowserRuntime.run` over the
 * fixture flows. Every step posts its label and this worker's id on the
 * `browser-test-log` channel before it runs. Under `?mode=block` the step
 * labelled `…:two` then never finishes, so a suite can kill the worker in it.
 */
import * as Effect from "effect/Effect"
import { BrowserRuntime } from "../../../src/index.ts"
import { flows, registration } from "../../fixtures/Flows.ts"

const mode = new URLSearchParams(self.location.search).get("mode")
const worker = crypto.randomUUID()
// Querying a lock unique to this worker gives its real Web Locks client id.
// The page compares it with the engine lock's owner, even after a takeover.
const identity = "browser-test-worker:" + worker
await navigator.locks.request(identity, async () => {
  const state = await navigator.locks.query()
  self.postMessage({ workerClientId: state.held!.find((lock) => lock.name === identity)!.clientId })
})
const log = new BroadcastChannel("browser-test-log")
BrowserRuntime.run({
  name: "browser-test",
  // The build loads only once this worker leads.
  sqlite: {
    module: () => import("@journeyapps/wa-sqlite/dist/wa-sqlite.mjs"),
    wasm: () => fetch("/wa-sqlite.wasm").then((response) => response.arrayBuffer())
  },
  flows,
  registerFlows: registration((label) =>
    Effect.sync(() => log.postMessage({ label, worker })).pipe(
      Effect.andThen(mode === "block" && label.endsWith(":two") ? Effect.never : Effect.succeed(label))
    )
  )
})
