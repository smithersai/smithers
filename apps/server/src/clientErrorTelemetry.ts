import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { ServerConfig } from "./Config"
import type { ClientErrorAppendOutcome } from "./clientErrorLog"
import { DeploymentBindings, ExecutionContext } from "./Environment"
import { discardBody, fetchWithDeadline } from "./Http"
import type { Transport } from "./Http"

const TELEMETRY_PATH = "/api/telemetry/errors"
const TELEMETRY_TIMEOUT_MS = 5_000

/**
 * Export only reports the durable log admitted, so its shared/source caps
 * govern backend traffic too. The backend needs only client + error type to
 * increment its alert counter: no report text, URL, browser credentials or
 * address crosses this seam. The local ring retains the diagnostic report.
 *
 * Admission still returns 202 independently of export. waitUntil owns the
 * bounded background attempt; failures log fixed classifications, never an
 * upstream body or exception that could echo the service credential.
 */
export const exportClientError = (
  outcome: ClientErrorAppendOutcome
): Effect.Effect<void, never, ServerConfig | Transport | DeploymentBindings | ExecutionContext> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const bindings = yield* DeploymentBindings
    const skipped = outcome !== "stored" ? outcome :
      !bindings.cloudApi || config.plueWorkerExchangeToken === undefined ? "unconfigured" : undefined
    if (skipped !== undefined) {
      console.error("client-error telemetry skipped:", skipped)
      return
    }
    const services = yield* Effect.context<Transport>()
    const ctx = yield* ExecutionContext
    const work = Effect.gen(function* () {
      const target = new URL(TELEMETRY_PATH, config.cloudApiBaseUrl)
      if (target.protocol !== "https:" || target.username !== "" || target.password !== "") {
        console.error("client-error telemetry failed:", { reason: "InvalidConfiguration" })
        return
      }
      const response = yield* fetchWithDeadline("Client error telemetry", target, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${Redacted.value(config.plueWorkerExchangeToken!)}`
        },
        body: JSON.stringify({ client: "web", version: config.buildSha.slice(0, 128), error: { type: "Error" } })
      }, Math.min(config.upstreamTimeoutMs, TELEMETRY_TIMEOUT_MS))
      yield* discardBody(response)
      if (response.status !== 204) console.error("client-error telemetry failed:", { status: response.status })
    }).pipe(
      Effect.catch((failure) => Effect.sync(() => console.error("client-error telemetry failed:", { reason: failure._tag }))),
      Effect.catchCause(() => Effect.sync(() => console.error("client-error telemetry failed:", { reason: "UnexpectedFailure" }))),
      Effect.provideContext(services)
    )
    yield* ctx.waitUntil(work)
  })
