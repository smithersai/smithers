import { Cause, Effect, Fiber, FiberSet, Scope } from "effect"
import { composeAgentInstructions } from "@smthrs/rpc/AgentContext"
import { CardPatchSchema, CardSchema } from "@smthrs/rpc/Cards"
import { AgentTurnDoneReasonSchema } from "@smthrs/rpc/NativeAgent"
import type {
  AgentTurnFrame,
  FetchLike,
  StartAgentTurnRequest,
  StartAgentTurnResult
} from "@smthrs/rpc/NativeAgent"
import { z } from "zod"

const DEFAULT_CHAT_URL = "https://chat.smithers.sh/chat"
const DEFAULT_APP_ORIGIN = "https://smithers.sh"
const MAX_ERROR_BYTES = 320

export interface CloudAgentConfig {
  readonly chatUrl?: string
  readonly origin?: string
  readonly fetchImpl?: FetchLike
}

type PublishFrame = (frame: AgentTurnFrame) => void

/** The upstream wire frame: an AgentTurnFrame without its runId (added on publish). */
const WireAgentFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("delta"),
    kind: z.enum(["reasoning", "text"]),
    text: z.string()
  }),
  z.object({
    type: z.literal("done"),
    reason: AgentTurnDoneReasonSchema.optional(),
    error: z.string().optional()
  }),
  z.object({ type: z.literal("card"), card: CardSchema }),
  z.object({ type: z.literal("card.update"), id: z.string(), patch: CardPatchSchema }),
  z.object({
    type: z.literal("tool_call"),
    call_id: z.string(),
    name: z.string(),
    arguments: z.string()
  })
])
type WireAgentFrame = z.infer<typeof WireAgentFrameSchema>

const isFrame = (value: unknown): value is WireAgentFrame => WireAgentFrameSchema.safeParse(value).success

const responseError = async (response: Response): Promise<string> => {
  const detail = (await response.text().catch(() => "")).trim().slice(0, MAX_ERROR_BYTES)
  return `Smithers Cloud chat failed (HTTP ${response.status})${detail === "" ? "." : `: ${detail}`}`
}

const asError = (error: unknown): Error => error instanceof Error ? error : new Error("Smithers Cloud chat failed.")

/*
 * One turn as an interruptible Effect (Ruling B, docs/persistence.md). The
 * fetch rides tryPromise's signal, which Effect aborts on interruption, and
 * the stream reader is acquired with a release, so an interrupted turn
 * cancels its in-flight read instead of leaving the stream open. There is no
 * AbortController and no `aborted` flag: cancellation IS fiber interruption.
 */
const streamTurn = (
  request: StartAgentTurnRequest,
  publish: PublishFrame,
  config: CloudAgentConfig
): Effect.Effect<void, Error, Scope.Scope> =>
  Effect.gen(function*() {
    // Billing belongs to this provider invocation, while frames and cancellation retain the caller's id.
    const upstreamRunId = crypto.randomUUID()
    // The hidden runtime context is rendered server-side into the
    // instructions: upstream sees one string, secrets and structure stay on
    // this side, and the visible transcript never holds it. The chat seam caps
    // that one string (16 KiB), so its size is named when the seam refuses.
    const composedInstructions = composeAgentInstructions(request.instructions, request.context)
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        (config.fetchImpl ?? fetch)(config.chatUrl?.trim() || DEFAULT_CHAT_URL, {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            origin: config.origin?.trim() || DEFAULT_APP_ORIGIN,
            "x-smithers-run-id": upstreamRunId
          },
          body: JSON.stringify({
            messages: request.messages,
            instructions: composedInstructions,
            // The tool-loop contract (Wave 3b): the tool specs ride every turn on
            // this boundary exactly as they do on the product Worker, otherwise the
            // model is never offered a command and the loop can never start.
            ...(request.tools === undefined ? {} : { tools: request.tools }),
            // The model-tier hint (the recommender's `cheap`); the serving side maps it.
            ...(request.tier === undefined ? {} : { tier: request.tier }),
            // The purpose and the named role (AgentRoles.ts) ride the wire as
            // hints too; a server that ignores them answers on its default model.
            // A cloud role (librarian, flows) is the exception: the app Worker
            // answers it itself on Cerebras (apps/server/src/cloudRoleTurn.ts),
            // and this native seam has no such key, so here it stays a hint.
            ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
            ...(request.role === undefined ? {} : { role: request.role })
          })
        }),
      catch: asError
    })
    if (!response.ok) {
      const message = yield* Effect.promise(() => responseError(response))
      // A size refusal names the size it refused, so the failure is diagnosable from the transcript.
      const sized = response.status === 400 && /instructions/i.test(message)
        ? `${message} (this turn's composed instructions were ${new TextEncoder().encode(composedInstructions).length} bytes)`
        : message
      return yield* Effect.fail(new Error(sized))
    }
    if (response.body === null) {
      return yield* Effect.fail(new Error("Smithers Cloud returned no response stream."))
    }

    const reader = yield* Effect.acquireRelease(
      Effect.sync(() => (response.body as ReadableStream<Uint8Array>).getReader()),
      (acquired) => Effect.promise(() => acquired.cancel().catch(() => {}))
    )
    const decoder = new TextDecoder()
    let buffer = ""
    let settled = false
    const readLine = (line: string): void => {
      if (line.trim() === "") return
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        return
      }
      if (!isFrame(parsed)) return
      switch (parsed.type) {
        case "delta":
          publish({ runId: request.runId, type: "delta", kind: parsed.kind, text: parsed.text })
          break
        case "card":
          publish({ runId: request.runId, type: "card", card: "runId" in parsed.card.payload && parsed.card.payload.runId === upstreamRunId
            ? CardSchema.parse({ ...parsed.card, payload: { ...parsed.card.payload, runId: request.runId } })
            : parsed.card })
          break
        case "card.update":
          publish({ runId: request.runId, type: "card.update", id: parsed.id, patch: parsed.patch })
          break
        case "tool_call":
          publish({
            runId: request.runId,
            type: "tool_call",
            call_id: parsed.call_id,
            name: parsed.name,
            arguments: parsed.arguments
          })
          break
        case "done":
          publish({
            runId: request.runId,
            type: "done",
            // `reason` is how the client tells an ordinary stop from the
            // upstream tool-call cap; dropping it turned an honest
            // tool_limit into a bare "empty response".
            ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
            ...(parsed.error ? { error: parsed.error } : {})
          })
          settled = true
          break
      }
    }

    for (;;) {
      const { value, done } = yield* Effect.promise(() => reader.read())
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split("\n")
      buffer = done ? "" : (lines.pop() ?? "")
      for (const line of lines) readLine(line)
      if (done || settled) break
    }
    if (!settled) publish({ runId: request.runId, type: "done" })
  })

export interface CloudAgent {
  readonly start: (request: StartAgentTurnRequest) => StartAgentTurnResult
  readonly cancel: (runId: string) => { readonly status: "cancelled" | "not-found" }
}

export const createCloudAgent = (
  publish: PublishFrame,
  config: CloudAgentConfig = {}
): CloudAgent => {
  /*
   * The scoped transport: one FiberSet owned by a Scope this agent holds, so
   * every turn it starts is a supervised fiber, and closing the scope would
   * interrupt them all. `cancel` interrupts the one fiber — the release on
   * the reader and the signal on the fetch do the rest. Interruption is not
   * an error, so a cancelled turn publishes no error frame (the old
   * `signal.aborted` check, now a Cause check).
   */
  const scope = Effect.runSync(Scope.make())
  const turns = Effect.runSync(FiberSet.make<void, unknown>().pipe(Effect.provideService(Scope.Scope, scope)))
  /*
   * Registered by identity, not by run id alone: a turn's teardown runs after
   * `cancel` already dropped it, and by then the same run id may hold the
   * turn that replaced it. Deleting by run id evicted that live turn, leaving
   * it uncancellable (`not-found`) and a second `start` for it permitted.
   */
  interface TurnEntry {
    fiber?: Fiber.Fiber<void, unknown>
  }
  const activeTurns = new Map<string, TurnEntry>()
  return {
    start: (request) => {
      if (activeTurns.has(request.runId)) {
        return { status: "error", message: "That Smithers turn is already running." }
      }
      // Registered before the fork so a turn that settles without ever
      // suspending deregisters itself instead of leaving a stale entry.
      const entry: TurnEntry = {}
      activeTurns.set(request.runId, entry)
      const turn = Effect.scoped(streamTurn(request, publish, config)).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.sync(() => {
              const failure = Cause.findError(cause)
              publish({
                runId: request.runId,
                type: "done",
                error: failure._tag === "Success" ? failure.success.message : "Smithers Cloud chat failed."
              })
            })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (activeTurns.get(request.runId) === entry) activeTurns.delete(request.runId)
          })
        )
      )
      entry.fiber = Effect.runSync(FiberSet.run(turns, turn))
      return { status: "started" }
    },
    cancel: (runId) => {
      const active = activeTurns.get(runId)
      if (active === undefined) return { status: "not-found" }
      activeTurns.delete(runId)
      if (active.fiber !== undefined) Effect.runFork(Fiber.interrupt(active.fiber))
      return { status: "cancelled" }
    }
  }
}
