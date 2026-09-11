/**
 * One agent turn, rendered as an NDJSON stream of `TurnFrame` lines.
 *
 * The Worker owns the turn because the agent runs here: the seat credential is
 * a Worker secret, the sandbox is a Worker-side QuickJS realm, and the cards
 * the agent paints come back over the same stream the text does. The browser
 * shell reads one JSON object per line and never polls.
 *
 * Milestone 1 ships the mock path. `env.APP_MOCK_TURN !== "0"` streams a
 * plausible sequence so the shell works end to end. `"0"` asks for the real
 * `Agent.run` path, which does not run under workerd yet, so it is refused
 * with {@link liveRuntimeUnsupported} rather than started: two blockers stop
 * it, and a caller that flips the flag deserves to be told which rather than
 * handed whichever of them fails first. `worker/README.md` records the shape
 * the live path will take.
 */
import type { AgentSpec, AnyFlowSpec, SandboxSpec, ToolsSpec } from "@smthrs/create-app/app"
import type { AppCard, FlowSummary, Message, SessionSummary, TurnFrame, TurnRequest } from "../src/api.ts"
import { ChainBalanceProps } from "../src/ChainBalanceProps.ts"
import { flows } from "../routes.gen.ts"
import type { Env } from "./env.ts"

/**
 * The half of `AppSession` a turn writes back into.
 *
 * A narrow structural seam rather than the class itself: `AppSession` imports
 * this module, so the dependency has to point one way.
 */
export interface TurnSession {
  /** Appends a transcript message and returns the stored row. */
  readonly appendMessage: (role: Message["role"], text: string) => Message
  /** Persists a card the turn emitted, so a reload replays it. */
  readonly appendCard: (card: AppCard) => void
  /** The `FlowStore.write` half: where `flows/write-flow` lands. */
  readonly writeFlow: (
    id: string,
    description: string,
    files: Record<string, string>
  ) => { readonly files: ReadonlyArray<string> }
  /** The flows this session has saved, for `FlowStore.list`. */
  readonly listFlows: () => ReadonlyArray<FlowSummary>
  /** Reports the turn's outcome to the session's row in the Recent column. */
  readonly settle: (status: SessionSummary["status"]) => void
}

export interface TurnOptions {
  readonly env: Env
  readonly session: TurnSession
  readonly request: TurnRequest
  /** Aborted by `POST /api/agent/turn/cancel` or by the client hanging up. */
  readonly signal: AbortSignal
}

/** One routed flow, as `routes.gen.ts` records it. */
interface FlowRoute {
  readonly id: string
  readonly spec: AnyFlowSpec
  readonly agent: AgentSpec
  readonly sandbox: SandboxSpec
  readonly tools: ToolsSpec
}

const routeFor = (flowId: string): FlowRoute | undefined =>
  (flows as unknown as ReadonlyArray<FlowRoute>).find((flow) => flow.id === flowId)

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()

/** One NDJSON line. Frames are plain JSON structs, so no encoder is needed. */
const line = (frame: TurnFrame): Uint8Array => encoder.encode(`${JSON.stringify(frame)}\n`)

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "The turn failed."

/**
 * The refusal `APP_MOCK_TURN=0` gets today, exported so the flow-run path and
 * the tests state the same thing once.
 *
 * Both blockers are named because each one is a fix in a different place,
 * and a deployer who set the flag has no other way to learn why nothing ran.
 * `worker/README.md` says where each lives.
 *
 * A third blocker used to be listed here: `@smthrs/create-app/runtime` built
 * `AgentAction.layerHost` without `flows`, so an app's tool sources never
 * reached a cell. `layerFor` passes `flows: tools.sources` now, so the claim
 * was false and is gone.
 */
export const liveRuntimeUnsupported =
  "unsupported_runtime: the live agent path does not run under workerd yet. Two blockers: "
  + "(1) this Worker passes layerFor no sandboxVariant, so the QuickJS sandbox compiles WebAssembly from bytes, which workerd refuses; "
  + "(2) @smthrs/database has no Durable Object SQLite driver, so a turn's journal does "
  + "not survive the request. Leave APP_MOCK_TURN at \"1\" until both land."

/**
 * Runs one turn and returns its NDJSON body.
 *
 * The stream is closed exactly once, on the one path every branch ends on: a
 * turn that fails still writes an `error` frame and then closes, because a
 * body that just stops is a spinner the shell cannot end.
 */
export const runTurn = (options: TurnOptions): ReadableStream<Uint8Array> => {
  const mock = options.env.APP_MOCK_TURN !== "0"
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (frame: TurnFrame): void => {
        controller.enqueue(line(frame))
      }
      try {
        // The refusal is raised rather than returned, so it takes the same
        // `error` frame and `failed` row every other turn failure takes. The
        // shell needs no branch for it.
        if (!mock) throw new Error(liveRuntimeUnsupported)
        await mockTurn(options, emit)
        options.session.settle(options.signal.aborted ? "idle" : "ready")
      } catch (cause) {
        // The Recent column is written before the refusal, because the refusal
        // is the part that may fail: a reader that hung up makes every enqueue
        // throw, so it is written on a best-effort basis.
        options.session.settle(options.signal.aborted ? "idle" : "failed")
        try {
          emit({ type: "error", message: failureMessage(cause) })
        } catch {
          // The stream is already gone.
        }
      } finally {
        try {
          controller.close()
        } catch {
          // Already closed by the reader cancelling.
        }
      }
    }
  })
}

// ---------------------------------------------------------------------------
// The mock turn
// ---------------------------------------------------------------------------

/**
 * The milestone-1 turn: one plausible sequence, no model call.
 *
 * It exercises every frame kind the shell renders — deltas, a `ctx.call`
 * result, a pane card, and a terminal `done` — so the transcript, the pane
 * host, and the cancel button are all reachable before the agent path lands.
 */
const mockTurn = async (options: TurnOptions, emit: (frame: TurnFrame) => void): Promise<void> => {
  const { request, session, signal } = options
  const route = routeFor(request.flowId)
  if (route === undefined) {
    throw new Error(`No flow is routed as "${request.flowId}".`)
  }
  const turnMessage = session.appendMessage("user", request.message)

  const deltas = [
    "Checking the balance",
    " on the forked chain",
    "..."
  ]
  let answer = ""
  for (const text of deltas) {
    if (signal.aborted) return emit({ type: "error", message: "The turn was cancelled." })
    answer += text
    emit({ type: "delta", text })
  }

  emit({
    type: "call",
    flow: "tevm/getBalance",
    input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
    outcome: "success"
  })

  const card: AppCard = {
    kind: "pane",
    // The persisted user message identifies this turn even across DO eviction.
    id: `${request.sessionId}:${turnMessage.id}:chain-balance`,
    name: "chain-balance",
    title: "Balance",
    props: ChainBalanceProps.make({
      chain: "mainnet",
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      native: { symbol: "ETH", amount: "1234567890123456789", decimals: 18 },
      tokens: []
    }),
    fullscreen: false
  }
  session.appendCard(card)
  emit({ type: "card", card })

  const closing = " That address holds about 1.23 ETH."
  answer += closing
  emit({ type: "delta", text: closing })
  session.appendMessage("assistant", answer)
  emit({ type: "done", output: { answer } })
}
