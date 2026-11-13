/**
 * Worker-entry regressions over the browser's real message port and event target.
 * Faults are injected through the SQLite source or telemetry Effect layer.
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import { BrowserRuntime } from "../../../src/index.ts"

const mode = new URLSearchParams(self.location.search).get("mode")
const logger = Logger.make((record) => {
  self.postMessage({
    _tag: "Log",
    ...Logger.formatStructured.log(record)
  })
})
BrowserRuntime.run({
  name: `runtime-entry-${crypto.randomUUID()}`,
  sqlite: {
    module: () => import("@journeyapps/wa-sqlite/dist/wa-sqlite.mjs"),
    wasm: () =>
      mode === "sqlite-failure"
        ? Promise.resolve(new Uint8Array([0]))
        : fetch("/wa-sqlite.wasm").then((response) => response.arrayBuffer())
  },
  flows: [],
  registerFlows: Layer.effectDiscard(Effect.sync(() => self.postMessage({ _tag: "Ready" }))),
  telemetry: mode === "telemetry-failure"
    ? Layer.effectDiscard(Effect.fail({ _tag: "TelemetryUnavailable" }))
    : Logger.layer([logger])
})

self.addEventListener("message", () => {
  setTimeout(() => {
    throw new TypeError("SENTINEL private callback")
  }, 0)
  void Promise.reject({ _tag: "Refused", message: "SENTINEL private rejection" })
  void Promise.reject("SENTINEL private string")
})
