import { FlowRuntime, Interpreter } from "@smthrs/flow"
import { Clock, Context, type Duration, Effect, Layer, Metric, Option } from "effect"
import { type Ask, asker } from "../../flows/askingTab"
import type { Door } from "../../flows/dispatch"
import { requesterOf } from "../../flows/requests"
import {
  ASK_TAB_WITHIN,
  type CopyOutcome,
  copyChannel,
  type EditOutcome,
  editChannel,
} from "./contract"
import { ChatCopy, ChatEdit, CopyMessage, EditQuestion, MessageNotFound, QuestionNotEditable } from "./flows"
import { messageCopies, questionEdits } from "./metrics"
import { CopyAnswer, type CopyCall, EditAnswer, type EditCall } from "./schema"

// The steps of `chat/copy` and `chat/edit` (docs/features/chat.md#message-controls). Each runs in the leader tab's engine
// worker, which has neither the conversation nor the clipboard, so it asks the tab that started its run over one of the
// engine's channels (src/flows/askingTab.ts): the tab whose button or slash command dispatched it, or, for the agent's
// call, the tab whose composer asked. That tab finds the message, writes its clipboard or its composer, and answers how
// it went (src/features/chat/tab.ts). A tab that is gone settles the step with `copied` or `edited` false. Nothing
// records a message's text.

/** This browser's tabs, as chat's steps reach them: only the tab that started a request answers. */
export class TabChat extends Context.Service<
  TabChat,
  {
    readonly copy: Ask<typeof CopyCall.Type, CopyAnswer>
    readonly edit: Ask<typeof EditCall.Type, EditAnswer>
  }
>()("@smthrs/mvp/chat/TabChat") {
  /** Over the copy and edit channels of engine `name`, waiting `within` (`ASK_TAB_WITHIN` unless set) for the tab. */
  static readonly layerChannel = (options: { readonly name: string; readonly within?: Duration.Input }) =>
    Layer.effect(
      TabChat,
      Effect.gen(function* () {
        const within = options.within ?? ASK_TAB_WITHIN
        return TabChat.of({
          copy: yield* asker<typeof CopyCall.Type, typeof CopyAnswer>({
            channel: copyChannel(options.name),
            output: CopyAnswer,
            within,
          }),
          edit: yield* asker<typeof EditCall.Type, typeof EditAnswer>({
            channel: editChannel(options.name),
            output: EditAnswer,
            within,
          }),
        })
      }),
    )
}

/**
 * Asks the tab that started the current run, and records how it went: a span `name`, a log line and a count, by door
 * and outcome, with the outcome `gone` when no tab answered. The agent's call (an execution that isn't its own
 * requester) counts as door `agent`.
 */
const askTab = <O extends string>(
  name: string,
  ask: (requester: string) => Effect.Effect<Option.Option<{ readonly door: Door; readonly output: { readonly outcome: O } }>>,
  record: (fields: { readonly door: Door | "unknown"; readonly outcome: O | "gone" }) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const { executionId } = yield* FlowRuntime.FlowInstance
    const requester = requesterOf(executionId)
    const reply = yield* ask(requester)
    const door: Door | "unknown" = executionId !== requester
      ? "agent"
      : Option.match(reply, { onNone: () => "unknown" as const, onSome: (answered) => answered.door })
    const outcome: O | "gone" = Option.match(reply, { onNone: () => "gone" as const, onSome: (a) => a.output.outcome })
    yield* record({ door, outcome })
    yield* Effect.annotateCurrentSpan({ "smithers.chat.door": door, "smithers.chat.outcome": outcome })
    const durationMs = (yield* Clock.currentTimeMillis) - startedAt
    const ok = outcome === "copied" || outcome === "edited"
    yield* Effect.logWithLevel(ok ? "Info" : outcome === "gone" || outcome === "failed" ? "Error" : "Warn")(name).pipe(
      Effect.annotateLogs({ door, outcome, executionId, durationMs, feature: "chat" }),
    )
    return outcome
  }).pipe(Effect.withSpan(name))

/**
 * What `chat/copy/write` does: asks the tab that started the run to copy the message, or its latest finished answer,
 * and counts it in `messageCopies` by door, which and outcome. No such message fails `MessageNotFound`; a tab that is
 * gone, or whose clipboard refused, answers `copied: false`.
 */
export const copyMessage = (payload: typeof CopyCall.Type) =>
  Effect.gen(function* () {
    const tabs = yield* TabChat
    const which = payload.messageId === undefined ? "latest" : "message"
    const outcome = yield* askTab<Exclude<CopyOutcome, "gone">>(
      "chat.copy",
      (requester) => tabs.copy(requester, payload),
      ({ door, outcome }) => Metric.update(Metric.withAttributes(messageCopies, { door, which, outcome }), 1),
    )
    if (outcome === "not_found") return yield* new MessageNotFound()
    return { copied: outcome === "copied" }
  })

/**
 * What `chat/edit/take` does: asks the tab that started the run to take the question back into its composer, and
 * counts it in `questionEdits` by door and outcome. A question the tab can't take back fails `QuestionNotEditable`; a tab
 * that is gone answers `edited: false`.
 */
export const editQuestion = (payload: typeof EditCall.Type) =>
  Effect.gen(function* () {
    const tabs = yield* TabChat
    const outcome = yield* askTab<Exclude<EditOutcome, "gone">>(
      "chat.edit",
      (requester) => tabs.edit(requester, payload),
      ({ door, outcome }) => Metric.update(Metric.withAttributes(questionEdits, { door, outcome }), 1),
    )
    if (outcome === "edited" || outcome === "gone") return { edited: outcome === "edited" }
    return yield* new QuestionNotEditable({ reason: outcome })
  })

/** Registers `chat/copy` and `chat/edit` with their steps, reaching the tabs through the host's `TabChat`. */
export const registration = Layer.mergeAll(
  Interpreter.layerWithImplementations(ChatCopy, CopyMessage.toLayer(copyMessage)),
  Interpreter.layerWithImplementations(ChatEdit, EditQuestion.toLayer(editQuestion)),
)
