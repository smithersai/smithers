import { AgentAction } from "@smthrs/agent"
import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Node, Placement, type Planned } from "@smthrs/plan"
import { Schema } from "effect"
import { AnswerSettled, AnswersUnavailable, NotYourTurn, TurnOutOfTime } from "./answers"
import { SETTLE_RETRY } from "./close"
import { MAX_FRAMES } from "./contract"
import { CHAT_SYSTEM } from "./instructions"
import { ProductWords } from "./words"
import { AnswerReference } from "./reference"
import { Exchange, Turn } from "./schema"

// The agent (docs/features/agent.md): `chat/Answer`, the flow that answers one question on this device's durable
// engine (decision 0011), started with the answer's id as its execution id:
//
//   chat/LoadTurn ─▶ chat/Respond (the agent: an AgentAction, @smthrs/agent's cell loop)
//                 ─▶ chat/Settle: done, or failed with why
//
// Every typed way the run ends settles the answer, as a step of the same run, so a crash anywhere still settles it on
// resume: the agent answering or failing, and the turn wait running out (`TurnOutOfTime`), which `chat/LoadTurn`
// itself answers once the queue before the answer hasn't moved for the turn wait. The flow declares no `deadline`: the engine ends a run past one
// with a defect, which settles nothing. A defect escapes a plan (`Node.catch` sees typed failures alone), and so does
// a device that never comes back; the server's `chat/Expire` settles those answers (worker/flows/Expire.ts).
//
// Each model call inside `chat/Respond` is a sealed `ModelStep` through the server's model endpoint, role `agent`; a
// resumed run replays what sealed and never pays for it twice. The agent's only authority is `ctx.call` on the app's
// own flows (src/flows/catalog.ts). What a step does is injected by the host (src/features/agent/host.ts), so the
// same flow runs in the browser's engine worker, on the Node host and later in the native app. This module imports
// @smthrs/agent, so only an engine's host imports it; the tab dispatches `chat/Answer` by its reference (./reference.ts).

/**
 * How `chat/LoadTurn` keeps asking while an earlier answer streams, or while the routes are unreachable: until its turn
 * comes, the answer settles, or the step answers `TurnOutOfTime` because the queue before it hasn't moved for the turn
 * wait. While the routes are unreachable nothing could be written anyway, so the policy never expires on its own;
 * `chat/Expire` settles the answer of a device that never comes back.
 */
export const TURN_RETRY = RetryPolicy.make({
  initialMs: 250,
  factor: 2,
  maxMs: 4_000,
  nonRetryable: ["@smthrs/mvp/agent/AnswerSettled", "@smthrs/mvp/agent/TurnOutOfTime"],
})

/**
 * Reads the answer's turn: its question and history, once every earlier answer has settled (decision 0002). While it
 * waits, it answers `TurnOutOfTime` once the routes say its turn has waited the host's turn wait since the queue before
 * it last moved (`ANSWER_TURN_WAIT` unless the host sets one). The routes measure that wait on Postgres' clock, so a
 * run resumed after a crash counts the time it waited before.
 */
export const LoadTurn = Action.make("chat/LoadTurn", {
  payload: { answerId: Schema.String },
  success: Turn,
  error: Schema.Union([NotYourTurn, AnswerSettled, AnswersUnavailable, TurnOutOfTime]),
  tier: "sealed",
  retryPolicy: TURN_RETRY,
})

/** The question as the agent reads it: the conversation so far, then the question. */
export const prompt = (turn: { readonly question: string; readonly history: ReadonlyArray<Exchange> }): string =>
  turn.history.length === 0
    ? turn.question
    : [
      "The conversation so far:",
      ...turn.history.flatMap((exchange) => [`Person: ${exchange.question}`, `Smithers: ${exchange.answer}`]),
      "",
      `The person now asks: ${turn.question}`,
    ].join("\n")

/**
 * How many times an answer that isn't in product words goes back to the agent, in its own session, before the answer
 * fails. Each costs one model call; the agent's earlier calls stay done and aren't made again.
 */
export const WORD_CORRECTIONS = 2

/**
 * The agent: answers the question, calling the app's flows from its cells, and finishes with the answer's text. The
 * text is declared `ProductWords`, so an answer naming a flow, a code or an id goes back to the agent to say plainly.
 */
export const OpeningRow = Schema.Struct({
  origin: Schema.Literal("recall"), bank: Schema.String, key: Schema.String, text: Schema.String,
})
export const RecalledTurn = Schema.Struct({
  question: Schema.String, history: Schema.Array(Exchange),
  candidates: Schema.Array(Schema.Struct({ kind: Schema.Literals(["memory", "skill"]), bank: Schema.String, key: Schema.String, text: Schema.String })),
})
export const PreparedTurn = Schema.Struct({
  question: Schema.String, history: Schema.Array(Exchange), opening: Schema.Array(OpeningRow),
  memoryDebug: Schema.Struct({ recalled: Schema.Int, inserted: Schema.Int, filtered: Schema.Int, skillsInserted: Schema.Int }),
})
export class OpeningFailed extends Schema.TaggedError<OpeningFailed>()("@smthrs/mvp/memory/OpeningFailed", { quota: Schema.optional(Schema.Boolean) }) {}
export class OpeningRefused extends Schema.TaggedError<OpeningRefused>()("@smthrs/mvp/memory/OpeningRefused", {}) {}
export const OPENING_RETRY = RetryPolicy.make({
  initialMs: 250, factor: 2, maxMs: 4000, maxAttempts: 3,
  nonRetryable: ["@smthrs/mvp/memory/OpeningRefused"],
})
export const RecallOpening = Action.make("chat/RecallOpening", {
  payload: Turn, success: RecalledTurn, error: Schema.Union([OpeningFailed, OpeningRefused]), tier: "sealed",
  retryPolicy: OPENING_RETRY,
})
export const Prepare = Action.make("chat/Opening", {
  payload: RecalledTurn,
  success: PreparedTurn,
  error: OpeningFailed,
  tier: "sealed",
})

export const Respond = AgentAction.make("chat/Respond", {
  payload: PreparedTurn,
  memory: ({ opening }) => opening,
  output: ProductWords,
  seat: "agent",
  system: CHAT_SYSTEM,
  profile: "conversation",
  prompt,
  maxFrames: MAX_FRAMES,
  corrections: WORD_CORRECTIONS,
})

/**
 * How the run ended, for `chat/Settle`: the agent's text, or `null` when it didn't answer; and whether the turn wait
 * ran out first, which settles the answer `unfinished`.
 */
export const Ending = Schema.Struct({ text: Schema.NullOr(Schema.String), timedOut: Schema.Boolean, failure: Schema.optional(Schema.Literal("quota")) })
export type Ending = typeof Ending.Type

/** Settles the answer as the run ended. The answer's parts come from the run. */
export const Settle = Action.make("chat/Settle", {
  payload: { answerId: Schema.String, ending: Ending },
  success: AnswerReference.successSchema,
  error: Schema.Union([AnswerSettled, AnswersUnavailable]),
  tier: "sealed",
  retryPolicy: SETTLE_RETRY,
})

/** Releases host progress only after settlement's durable retries have ended. */
export const ForgetProgress = Action.make("chat/ForgetProgress", {
  payload: { answerId: Schema.String },
  success: Schema.Void,
  tier: "sealed",
})

/** The settlement graph: terminal failures release progress and retain their original error. */
export const settle = (payload: Parameters<typeof Settle.call>[0]) =>
  Settle.call(payload).pipe(Node.catch({
    onFailure: Node.capture({ forget: ForgetProgress.name }, (error: Planned.Planned<AnswerSettled | AnswersUnavailable>) =>
      ForgetProgress.call({ answerId: payload.answerId }).pipe(Node.andThen(Node.fail(error)))),
  }))

/**
 * `chat/Answer { answerId }`: answers the question asked with this answer's id, on this device. Its tag and schemas are
 * its reference's (./reference.ts), the very objects the tab dispatches by.
 */
export const Answer = Flow.make(AnswerReference._tag, {
  description: "Answer the question asked with this answer id.",
  modelInvocable: false,
  payload: AnswerReference.payloadSchema,
  success: AnswerReference.successSchema,
  error: AnswerReference.errorSchema,
  body: Node.capture(
    { load: LoadTurn.name, recall: RecallOpening.name, opening: Prepare.name, respond: Respond.name, settle: Settle.name },
    ({ answerId }) =>
      LoadTurn.call({ answerId }).pipe(
        Node.bindPlanned(Node.capture({ recall: RecallOpening.name, opening: Prepare.name, respond: Respond.name }, (turn) =>
          RecallOpening.call(turn).pipe(
            Node.bindPlanned(Node.capture({ opening: Prepare.name }, (recalled) => Prepare.call(recalled))),
            Node.bindPlanned(Node.capture({ respond: Respond.name }, (prepared) => Respond.call(prepared))),
            Node.map(Node.capture({ timedOut: false }, (text: string): Ending => ({ text, timedOut: false }))),
            // Preserve a quota refusal in the sealed ending, including after the tab loses its progress.
            // expected: a quota refusal becomes the sealed ending
            Node.catch({
              error: Schema.Union([
                Schema.Struct({ _tag: Schema.Literal("@smthrs/mvp/memory/OpeningFailed"), quota: Schema.Literal(true) }),
                Schema.Struct({
                  _tag: Schema.Literal("/harness/HarnessError"),
                  code: Schema.Literal("model_failed"),
                  cause: Schema.Struct({ _tag: Schema.Literal("flows/model/ModelError"), code: Schema.Literals(["quota_exceeded", "out_of_credit"]) }),
                }),
              ]),
              onFailure: Node.capture({ failure: "quota" }, () => Node.succeed<Ending>({ text: null, timedOut: false, failure: "quota" })),
            }),
            // The agent failed: the settle reads why from the run's progress.
            // expected: the engine records the failed step
            Node.catch({
              onFailure: Node.capture({ text: null }, () => Node.succeed<Ending>({ text: null, timedOut: false })),
            }),
          ))),
        // expected: a turn out of time settles as timed out
        Node.catch({
          // By its tag: a class schema has no identity that survives a process, so a resumed run couldn't match it.
          error: Schema.Struct({ _tag: Schema.Literal("@smthrs/mvp/agent/TurnOutOfTime") }),
          onFailure: Node.capture({ timedOut: true }, () => Node.succeed<Ending>({ text: null, timedOut: true })),
        }),
        Node.bindPlanned(Node.capture({ settle: Settle.name }, (ending) => settle({ answerId, ending }))),
      ),
  ),
}).annotate(Flow.Placement, Placement.client())
