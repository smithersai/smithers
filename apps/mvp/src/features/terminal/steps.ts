import { Interpreter } from "@smthrs/flow"
import { Clock, Effect, Layer, Metric } from "effect"
import { type OpenRefused, TerminalClient } from "./api"
import { type OpenFailure, RequestOpen, TerminalOpenRefused, TerminalOpenRequest, TerminalOpenUnavailable } from "./flows"
import { opens } from "./metrics"

// `terminal/open`'s step (docs/features/branch-workspace.md#the-terminal): one `POST /api/terminals` through
// `TerminalClient`, on this device's engine.

/** What ChatApi's refusal means to the flow. */
export const openFailure = (refused: OpenRefused): OpenFailure =>
  refused.status === 401
    ? new TerminalOpenRefused({ reason: "sign_in" })
    : refused.status === 403
    ? new TerminalOpenRefused({ reason: refused.code === "members_only" ? "members_only" : "forbidden" })
    : refused.status === 409 && refused.code === "locked"
    ? new TerminalOpenRefused({ reason: "locked" })
    : refused.status === 404
    ? new TerminalOpenRefused({ reason: "not_found" })
    : refused.status === 400 || refused.status === 413
    ? new TerminalOpenRefused({ reason: "invalid" })
    : new TerminalOpenUnavailable()

/**
 * What `terminal/open/request` does: one `POST /api/terminals`. Records a span `terminal.open`, a log line with the
 * outcome and ChatApi's status, and a count of `opens` by outcome: `opening`, the refusal's reason, or `unavailable`.
 */
export const requestOpen = (request: typeof RequestOpen.payloadSchema.Type) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const answer = yield* Effect.result((yield* TerminalClient).open(request))
    const failure = answer._tag === "Failure" ? openFailure(answer.failure) : undefined
    const outcome = failure === undefined
      ? "opening"
      : failure._tag === "@smthrs/mvp/terminal/TerminalOpenRefused"
      ? failure.reason
      : "unavailable"
    yield* Metric.update(Metric.withAttributes(opens, { outcome }), 1)
    yield* Effect.annotateCurrentSpan({ outcome })
    yield* Effect.logWithLevel(failure === undefined ? "Info" : "Warn")("terminal.open").pipe(
      Effect.annotateLogs({
        outcome,
        terminalId: request.terminalId,
        branchId: request.branchId,
        ...(answer._tag === "Failure" && answer.failure.status !== undefined ? { status: answer.failure.status } : {}),
        durationMs: (yield* Clock.currentTimeMillis) - startedAt,
        feature: "terminal",
      }),
    )
    if (answer._tag === "Success") return answer.success
    return yield* Effect.fail(failure!)
  }).pipe(Effect.withSpan("terminal.open"))

/** Registers `terminal/open` with its step, asking through the host's `TerminalClient`. */
export const registration = Interpreter.layerWithImplementations(TerminalOpenRequest, RequestOpen.toLayer(requestOpen))

/** `terminal/open`, asking ChatApi on `origin`. Needs the host's `HttpClient`. */
export const registrationAt = (origin: string) => registration.pipe(Layer.provide(TerminalClient.layer({ origin })))
