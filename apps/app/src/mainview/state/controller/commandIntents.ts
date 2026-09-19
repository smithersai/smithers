import { decideApprovalAnswerInput } from "../ApprovalAnswerState"
import { browserWriteRefusal } from "../BrowserWriteFailure"
import { decideFormFieldInput } from "./forms"
import { reserveBrowserCommandGesture } from "../../flows/CommandGesture"
import { digest } from "@smthrs/core/Digest"
import { retiredLineageKey } from "../../chain/LineageRetirement"
import type { CommandLifecycle, CommandRequest, PendingCommandInput } from "../../flows/CommandLifecycle"
import { canonicalEventValue } from "../EventValue"
import type { ControllerContext } from "./context"

const currentHttpCall = (ctx: ControllerContext, call: CommandRequest["httpCall"]): boolean => {
  if (call === undefined) return true
  if (ctx.store.session().turnId !== call.turnId || ctx.store.session().phase !== "responding") return false
  if (call.attemptId === undefined && call.legId === undefined) return true // legacy adapters
  const turn = call.attemptId === undefined ? undefined : ctx.store.collections.httpTurns.get(call.attemptId)
  const leg = call.legId === undefined ? undefined : ctx.store.collections.httpTurnLegs.get(call.legId)
  return turn?.status === "active" && turn.turnId === call.turnId && turn.legId === leg?.id &&
    leg.attemptId === turn.id && leg.status === "tool-executing" && leg.call?.callId === call.callId
}

/** Command facts contain metadata only. Pending human edits never execute a form submission. */
export const createCommandIntentLifecycle = (ctx: ControllerContext, onAccepted?: (request: CommandRequest) => void): CommandLifecycle => ({
  reserveGesture: (request, args, named) => {
    if (ctx.disposed || request.actor !== "user") return undefined
    let name = request.name
    if (name === "form.submit") {
      const id = typeof named?.cardId === "string" ? named.cardId : args?.trim()
      const card = id === undefined ? undefined : ctx.store.collections.cards.get(id)
      if (card?.kind !== "flow-form" || card.payload.via !== "user" || card.payload.submitting || card.status === "acted") return undefined
      name = card.payload.flow
    }
    if (name === "auth.sign-in") {
      if (ctx.services.openExternal !== undefined || (ctx.services.bootstrap?.host !== "local" && ctx.services.bootstrap?.authFlow !== "native-handoff") || ctx.store.collections.identitySessions.get("identity")?.state !== "signed-out") return undefined
    }
    if (name === "app.download" && (ctx.services.openExternal !== undefined || ctx.services.downloadUrl === null)) return undefined
    return reserveBrowserCommandGesture(name)
  },
  accept: async (request, pendingFormInput) => {
    if (ctx.disposed || request.invocation?.signal?.aborted) return { refusal: "The command's controller or turn is closed.", persistenceFailed: true }
    const lineage = request.invocation?.lineage
    if (lineage !== undefined && ctx.store.collections.retiredChainLineages.has(retiredLineageKey(lineage))) {
      return { refusal: "This command belongs to retired execution history." }
    }
    const epoch = ctx.accountEpoch
    const identity = ctx.store.collections.identitySessions.get("identity")
    const owner = identity?.accountOwnerLogin ?? identity?.login ?? null
    if (!currentHttpCall(ctx, request.httpCall)) {
      return { refusal: "This command belongs to a turn that is no longer active." }
    }
    // A form submission is a new gesture, not a replay of the incomplete ask
    // which rendered it. Its outer agent form.submit still owns a stable slot.
    const invocationKey = request.httpCall !== undefined ? digest(canonicalEventValue({ owner, actor: request.actor, httpCall: request.httpCall, name: request.name }))
      : lineage === undefined || request.source === "form" ? undefined : digest(canonicalEventValue({
        owner, actor: request.actor, lineage, slot: {
          chain: request.invocation!.slot.chain, link: request.invocation!.slot.link,
          ordinal: request.invocation!.slot.ordinal, key: request.invocation!.slot.key
        }, name: request.name
      }))
    const attempts = invocationKey === undefined ? [] : [...ctx.store.collections.commandIntents.values()]
      .filter(row => row.invocationKey === invocationKey).sort((a, b) => b.acceptedRevision - a.acceptedRevision)
    const existing = attempts[0]
    if (existing !== undefined && (existing.status !== "settled" || existing.retryable !== true)) return { refusal: existing.status === "accepted"
      ? "This command was already accepted, but its outcome is unknown. Check the result before explicitly trying again."
      : "This command already has a saved outcome. It will not run again from the same execution call." }
    const id = invocationKey === undefined ? `command-${crypto.randomUUID()}` : `command-call-${invocationKey}${attempts.length === 0 ? "" : `-${attempts.length + 1}`}`
    let pendingInput: PendingCommandInput | undefined
    try {
      if (request.actor === "user" && request.name === "form.set" && pendingFormInput !== undefined) {
        const { cardId, field, value } = pendingFormInput
        const candidate = ctx.store.collections.cards.get(cardId)
        const decided = decideFormFieldInput(candidate?.kind === "flow-form" ? candidate : undefined, cardId, field, value)
        if (!("error" in decided)) pendingInput = ctx.store.stagePendingCardInput(cardId, decided.card, id, field)
        else {
          const answer = decideApprovalAnswerInput(ctx.store, cardId, field, value)
          if (!("error" in answer)) pendingInput = ctx.store.stagePendingApprovalAnswer(answer, id)
        }
      }
      await ctx.store.dispatch({ type: "command.intent.accepted", actor: request.actor,
        id, name: request.name, source: request.source, invocationKey }).isPersisted.promise
      const accepted = ctx.store.collections.commandIntents.get(id)
      if (ctx.disposed || ctx.accountEpoch !== epoch || request.invocation?.signal?.aborted || accepted?.status !== "accepted"
        || !currentHttpCall(ctx, request.httpCall)) {
        pendingInput?.clear()
        return { refusal: "The command's controller, account, or turn changed before it could start.", persistenceFailed: true }
      }
      onAccepted?.(request)
      return { receipt: { id, actor: request.actor, acceptedRevision: accepted.acceptedRevision }, ...(pendingInput === undefined ? {} : { pendingInput }) }
    } catch (error) {
      pendingInput?.clear()
      /*
       * The act reached nothing durable because this BROWSER would not take
       * the write, which is a different thing from the act being refused and
       * a different thing again from a bug. "The command could not be saved"
       * was true and unactionable: it named no cause, no next step, and for
       * two of these faults it left the reader to assume it was theirs.
       */
      return { refusal: browserWriteRefusal(error), persistenceFailed: true, writeRefused: true }
    }
  },
  canExecute: (receipt, request) => {
    const row = ctx.store.collections.commandIntents.get(receipt.id)
    return !ctx.disposed && !request.invocation?.signal?.aborted && row?.status === "accepted"
      && row.acceptedRevision === receipt.acceptedRevision && row.actor === receipt.actor
      && currentHttpCall(ctx, request.httpCall)
  },
  settle: async (receipt, outcome, retryableAuthorization = false) => {
    const accepted = ctx.store.collections.commandIntents.get(receipt.id)
    // Sign-out/reset may deliberately erase its own private acceptance. The
    // durable privacy transaction is the receipt; do not recreate erased metadata.
    if (!ctx.disposed && accepted === undefined) {
      try { await ctx.store.settled?.(); return true } catch { return false }
    }
    if (ctx.disposed || accepted?.status !== "accepted" || accepted.actor !== receipt.actor || accepted.acceptedRevision !== receipt.acceptedRevision) return false
    try {
      await ctx.store.dispatch({ type: "command.intent.settled", actor: receipt.actor, id: receipt.id, outcome: outcome.status,
        ...(retryableAuthorization && outcome.status === "failed" ? { retryable: true } : {}) }).isPersisted.promise
      return ctx.store.collections.commandIntents.get(receipt.id)?.status === "settled"
    } catch { return false }
  }
})
