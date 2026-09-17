/** A session health checker that asks Jev whether an agent is waiting on a person.
 *
 * Jev, TypeSafe's decision model, reads a state and answers typed questions
 * about it in about 300 ms. It writes no text, so it can never name an option
 * the question did not offer, and the questions in one request are answered in
 * parallel, so a second question costs no latency. The web app already asks it
 * through `apps/server/src/jev.ts`; the engine runs outside the Worker, so this
 * module is the same wire contract written with plain `fetch`.
 *
 * The state is the session's own lifecycle plus the newest bytes of its output.
 * The answer is a `ProbeReport` and nothing else: a checker's output never
 * authorizes a control mutation, and an unreachable, refused, slow, or
 * unreadable gateway degrades to the lifecycle answer rather than inventing
 * activity. The monitor's job is to notice a person is blocked, so a probe that
 * cannot tell must say it cannot tell.
 *
 * @since 1.0.0
 */
import { Effect } from "effect"
import type { CheckPolicy, HealthChecker, ProbeContext, ProbeReport } from "./Health.ts"

/** The Vercel AI Gateway route that serves evaluation models.
 * @category constants
 * @since 1.0.0
 */
export const jevEvaluationUrl = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model"

/** The gateway's id for Jev.
 * @category constants
 * @since 1.0.0
 */
export const jevModelId = "typesafe-ai/jev"

/** The newest characters of session output carried as state.
 *
 * A waiting prompt is the last thing an agent printed, so the clip keeps the
 * end. Four KiB holds a screenful of tool output ahead of the prompt without
 * paying for a scrollback the question cannot use.
 *
 * @category constants
 * @since 1.0.0
 */
export const jevStateTailCharacters = 4 * 1024

/** The deadline on one gateway call.
 *
 * Jev answers in about 300 ms; a status that arrives after the operator has
 * looked away is noise, and a slow gateway must not hold a probe slot.
 *
 * @category constants
 * @since 1.0.0
 */
export const jevRequestTimeoutMs = 1_500

/** The probe budget this checker asks a binding for.
 *
 * It sits above {@link jevRequestTimeoutMs} so this checker's own abort, which
 * degrades to the lifecycle answer, fires before `Health.evaluate` records a
 * bare `probe-timeout` that says nothing about the session.
 *
 * @category constants
 * @since 1.0.0
 */
export const jevProbeTimeoutMs = 2_500

/** The confidence an answer must carry before it becomes a status.
 *
 * TypeSafe reports 76% agreement with frontier-model reference labels on its
 * own evals, so a Jev that is merely leaning is a coin flip dressed as a
 * reading. Below this floor the probe answers `unknown`: a false `needs-input`
 * pages a person who is not needed, and a false `idle` retires an agent that
 * is still working.
 *
 * @category constants
 * @since 1.0.0
 */
export const jevConfidenceFloor = 0.7

/** Injection points for the one network call this checker makes.
 *
 * `env` and `fetch` default to the host process; naming either one keeps a test
 * or a hermetic host off the network and off the ambient key.
 *
 * @category models
 * @since 1.0.0
 */
export interface JevSessionCheckerOptions {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly url?: string | undefined
  readonly timeoutMs?: number | undefined
}

/** What the lifecycle session checker answers, and what every degradation here returns. */
const lifecycleReport: ProbeReport = { activity: "unknown", reason: "ok" }

/** The options Jev chooses between, and what each one means to a reader of terminal output. */
const activityCriteria = {
  "working": "the agent is executing tools, editing files, or producing work",
  "idle": "the agent finished and is producing nothing",
  "needs-input": "the agent asked the person a question, requested approval or a credential, and is waiting"
} as const

const questions = {
  activity: {
    type: "choice",
    instructions: "Read the tail of this agent session's output. What is the agent doing right now?",
    criteria: activityCriteria
  },
  question: {
    type: "boolean",
    instructions: "Does the output end with the agent waiting for a person to answer?"
  }
} as const

/** Reads the host process environment by deliberate default, spelled once rather than inline. */
const ambientEnvironment = (): Readonly<Record<string, string | undefined>> => process.env

const confidenceOf = (payload: unknown, id: string): number => {
  const metadata = (payload as { providerMetadata?: { typesafe?: { confidence?: Record<string, unknown> } } })
    ?.providerMetadata?.typesafe?.confidence?.[id]
  return typeof metadata === "number" ? metadata : 0
}

/** One evaluation, or `undefined` for every way the gateway can fail to answer one. */
const evaluate = async (
  options: JevSessionCheckerOptions,
  key: string,
  state: { readonly alive: boolean; readonly exitCode: number | null; readonly outputTail: string }
): Promise<unknown> => {
  try {
    const response = await (options.fetch ?? globalThis.fetch)(options.url ?? jevEvaluationUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "ai-gateway-protocol-version": "0.0.1",
        "ai-gateway-auth-method": "api-key",
        "ai-evaluation-model-specification-version": "4",
        "ai-model-id": jevModelId,
        "content-type": "application/json"
      },
      // Session output is the operator's terminal. It is read for one decision and never retained.
      body: JSON.stringify({ state, questions, providerOptions: { gateway: { zeroDataRetention: true } } }),
      signal: AbortSignal.timeout(options.timeoutMs ?? jevRequestTimeoutMs)
    })
    if (!response.ok) {
      await response.body?.cancel()
      return undefined
    }
    return await response.json()
  } catch {
    // A bad key, a plan refusal, a rate limit, a dead socket and this call's own
    // deadline are all the same fact to a monitor: nobody looked at the session.
    return undefined
  }
}

/** Build a Jev session checker over an explicit environment and transport.
 *
 * The probe reads `AI_GATEWAY_API_KEY`. Without a key, without an exposed
 * output tail, or against a session that is no longer alive it answers exactly
 * what `Health.lifecycleSessionChecker` answers and never opens a connection,
 * so a host that has not configured Jev pays nothing for the binding.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeJevSessionChecker = (options: JevSessionCheckerOptions = {}): HealthChecker => ({
  id: "jev.session",
  defaults: { timeoutMs: jevProbeTimeoutMs } satisfies Partial<CheckPolicy>,
  probe: (context: ProbeContext) =>
    Effect.gen(function*() {
      const session = context.session
      const tail = session?.outputTail
      if (session === undefined || !session.alive || tail === undefined || tail === "") return lifecycleReport
      const key = (options.env ?? ambientEnvironment())["AI_GATEWAY_API_KEY"]
      if (key === undefined || key === "") return lifecycleReport
      const payload = yield* Effect.promise(() =>
        evaluate(options, key, {
          alive: session.alive,
          exitCode: session.exitCode,
          outputTail: tail.length > jevStateTailCharacters ? tail.slice(-jevStateTailCharacters) : tail
        })
      )
      const answer = (payload as { answers?: Record<string, { type?: string; choice?: unknown }> })?.answers?.[
        "activity"
      ]
      if (answer?.type !== "choice" || typeof answer.choice !== "string") return lifecycleReport
      // The boolean rides along for free and is recorded as evidence only. It
      // has to be scored against the choice before it earns a vote in it. A
      // boolean answer carries its probability directly and no confidence.
      const waiting = (payload as { answers?: Record<string, { probability?: unknown }> })?.answers?.["question"]
        ?.probability
      yield* Effect.annotateCurrentSpan({ "jev.waiting": typeof waiting === "number" ? waiting : -1 })
      if (confidenceOf(payload, "activity") < jevConfidenceFloor) return lifecycleReport
      return answer.choice === "needs-input"
        ? { activity: "needs-input", reason: "prompt-detected" }
        : answer.choice === "working" || answer.choice === "idle"
        ? { activity: answer.choice, reason: "ok" }
        : lifecycleReport
    })
})

/** The checker `makeRegistry` admits under `jev.session`, reading the host's own environment.
 *
 * It is registered, not bound: a host opts in by naming `jev.session` as a
 * `HealthBinding.checkerId` with `exposeOutput: true`, and every host that does
 * not keeps the lifecycle default it had.
 *
 * @category constants
 * @since 1.0.0
 */
export const jevSessionChecker: HealthChecker = makeJevSessionChecker()
