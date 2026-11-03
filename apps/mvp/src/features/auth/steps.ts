import { FlowRuntime, Interpreter } from "@smthrs/flow"
import { Clock, Context, type Duration, Effect, Layer, Option } from "effect"
import { type Ask, asker } from "../../flows/askingTab"
import { requesterOf } from "../../flows/requests"
import { ASK_SESSION_WITHIN, sessionChannel } from "./contract"
import { AuthRefresh, CheckSession, SessionUnreachable } from "./flows"
import { SessionAnswer, type SessionCall } from "./schema"

// `auth/refresh`'s step (docs/features/sign-in.md#when-chatapi-cant-say). It runs in the leader tab's engine worker,
// which neither holds the tab's sign-in state nor reads the session for it, so it asks the tab that started the run
// over the engine's channel (src/flows/askingTab.ts); that tab checks its session as it does when it opens
// (src/features/auth/tab.ts). While ChatApi can't say, the step fails `SessionUnreachable` and the engine's retry policy
// asks again. A tab that is gone settles the run.

/** This browser's tabs, as the refresh's step reaches them: only the tab that started the run answers. */
export class TabSession extends Context.Service<
  TabSession,
  { readonly check: Ask<typeof SessionCall.Type, SessionAnswer> }
>()("@smthrs/mvp/auth/TabSession") {
  /** Over the session channel of engine `name`, waiting `within` (`ASK_SESSION_WITHIN` unless set) for the tab. */
  static readonly layerChannel = (options: { readonly name: string; readonly within?: Duration.Input }) =>
    Layer.effect(
      TabSession,
      Effect.map(
        asker<typeof SessionCall.Type, typeof SessionAnswer>({
          channel: sessionChannel(options.name),
          output: SessionAnswer,
          within: options.within ?? ASK_SESSION_WITHIN,
        }),
        (check) => TabSession.of({ check }),
      ),
    )
}

/**
 * What `auth/refresh/check` does: asks the tab that started the run to check its session, and records how it went as a
 * span and a log line `auth.refresh.check`, with the outcome, `gone` when no tab answered. A check ChatApi couldn't
 * answer fails `SessionUnreachable`, which the engine tries again; every other outcome settles the run.
 */
export const checkSession = Effect.gen(function* () {
  const tabs = yield* TabSession
  const startedAt = yield* Clock.currentTimeMillis
  const { executionId } = yield* FlowRuntime.FlowInstance
  const reply = yield* tabs.check(requesterOf(executionId), {})
  const outcome = Option.match(reply, { onNone: () => "gone" as const, onSome: (answered) => answered.output.outcome })
  yield* Effect.annotateCurrentSpan({ "smithers.auth.outcome": outcome })
  const durationMs = (yield* Clock.currentTimeMillis) - startedAt
  yield* Effect.logWithLevel(outcome === "unreachable" || outcome === "unconfirmed" ? "Warn" : "Info")("auth.refresh.check").pipe(
    Effect.annotateLogs({ outcome, executionId, durationMs, feature: "auth" }),
  )
  if (outcome === "unreachable" || outcome === "unconfirmed") return yield* new SessionUnreachable()
  return { outcome }
}).pipe(Effect.withSpan("auth.refresh.check"))

/** Registers `auth/refresh` with its step, reaching the tabs through the host's `TabSession`. */
export const registration = Interpreter.layerWithImplementations(AuthRefresh, CheckSession.toLayer(() => checkSession))
