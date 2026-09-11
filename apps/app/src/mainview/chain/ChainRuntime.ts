import { Catalog, Chain, Journal, Prompt, QuickJsRunner, Steering, SubChains } from "@smthrs/chain"
import type { Author, Event, Outcome, ScriptRunner } from "@smthrs/chain"
import { Cause, Effect, Exit, Fiber, Layer, Option, Ref, Schema } from "effect"
import { CardPatchSchema, CardSchema } from "@smthrs/rpc/Cards"
import type { AgentChatMessage, AgentTurnFrame, FetchLike, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import type { CommandRegistry } from "../flows/Commands"
import type { AgentPort } from "../runtime/AgentPort"
import type { AppStore } from "../state/AppStore"
import { isRuntimeOwnedCard } from "../state/isRuntimeOwnedCard"
import { makeCollectionJournal } from "./CollectionJournal"
import { commandEntries, disclosedEntries } from "./FlowCatalog"
import { retiredLineageKey } from "./LineageRetirement"
import { createChainPolicy } from "./Policy"
import { layerAuthor } from "./StreamModel"
import { hostPrompt } from "./HostPrompt"
import { worldviewEntries } from "./Worldview"

/*
 * The Agent Chain behind the AgentPort seam (DESIGN.md §14). One turn is
 * one lineage: startTurn trampolines Chain.run over the chainEvents journal,
 * the journal tee folds every appended event into chain frames, and the
 * surface entries (say, card.show, card.update) are the model's doors to the
 * transcript — the same frame path the proxy backend uses, so the controller
 * and renderers do not know which backend produced a frame. The controller's
 * per-turn instructions/tools are ignored here: the prefix is
 * Prompt.assemble over the disclosed catalog, and context is the request's
 * transcript rendered compactly — authored context assembly grows from that
 * floor as the worldview entries land.
 */

type Emit = (frame: AgentTurnFrame) => void

export interface ChainRuntimeOptions {
  readonly store: AppStore
  readonly commands: CommandRegistry
  readonly baseUrl?: string
  readonly fetchImpl?: FetchLike
  readonly modelId?: string
  readonly maxLinks?: number
  readonly maxCallsPerLink?: number
  /** Additional host catalog entries beyond the command projection and doors. */
  readonly entries?: ReadonlyArray<Catalog.Entry>
  /** Test seams: replace the author seat and the sealed runner. */
  readonly authorLayer?: Layer.Layer<Author.Author>
  readonly runnerLayer?: Layer.Layer<ScriptRunner.ScriptRunner, unknown>
}

const CONTEXT_MESSAGE_LIMIT = 30
const MAX_BACKGROUNDS = 3
const BackgroundSpec = Schema.Struct({
  goal: Schema.String,
  context: Schema.optional(Schema.Array(Schema.String))
})
const decodeBackground = Schema.decodeUnknownOption(BackgroundSpec)

const contextLines = (messages: ReadonlyArray<AgentChatMessage>): ReadonlyArray<string> =>
  messages
    .filter(
      (message): message is { readonly role: "user" | "assistant"; readonly content: string } =>
        "role" in message && typeof message.content === "string" && message.content !== ""
    )
    .slice(-CONTEXT_MESSAGE_LIMIT)
    .map((message) => `${message.role === "user" ? "user" : "smithers"}: ${message.content}`)

const goalOf = (messages: ReadonlyArray<AgentChatMessage>): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && "role" in message && message.role === "user" && message.content !== "") {
      return message.content
    }
  }
  return "Continue."
}

/** The model's doors to the transcript, bound to this turn's frame stream. */
const surfaceEntries = (emit: Emit, runId: string, store: AppStore): ReadonlyArray<Catalog.Entry> => [
  {
    name: "say",
    description: "Show the user a chat message (markdown). Payload: { text: string }",
    handler: (payload) => {
      const text = typeof payload === "object" && payload !== null && "text" in payload
        ? (payload as { readonly text?: unknown }).text
        : undefined
      if (typeof text !== "string" || text === "") {
        return Effect.fail(new Catalog.CallError({ name: "say", message: "payload.text must be a non-empty string" }))
      }
      return Effect.sync(() => {
        emit({ runId, type: "delta", kind: "text", text })
        return { shown: true }
      })
    }
  },
  {
    name: "card.show",
    description: "Embed a typed card in the transcript. Payload: { card: Card }",
    handler: (payload) => {
      const card = typeof payload === "object" && payload !== null && "card" in payload
        ? (payload as { readonly card?: unknown }).card
        : undefined
      const parsed = CardSchema.safeParse(card)
      if (!parsed.success) {
        return Effect.fail(
          new Catalog.CallError({
            name: "card.show",
            message: `payload.card is not a valid card: ${parsed.error.message}`
          })
        )
      }
      if (isRuntimeOwnedCard(parsed.data) || isRuntimeOwnedCard(store.collections.cards.get(parsed.data.id)) ||
        store.approvalRequest(parsed.data.id) !== undefined) {
        return Effect.fail(new Catalog.CallError({ name: "card.show", message: "This card is runtime-owned." }))
      }
      return Effect.sync(() => {
        const card = parsed.data.kind === "flow-form"
          ? { ...parsed.data, payload: { ...parsed.data.payload, via: "agent" as const } }
          : parsed.data
        emit({ runId, type: "card", card })
        return { shown: parsed.data.id }
      })
    }
  },
  {
    name: "card.update",
    description: "Patch an embedded card. Payload: { id: string, patch: CardPatch }",
    handler: (payload) => {
      const record = typeof payload === "object" && payload !== null
        ? (payload as { readonly id?: unknown; readonly patch?: unknown })
        : {}
      const patch = CardPatchSchema.safeParse(record.patch)
      if (typeof record.id !== "string" || record.id === "" || !patch.success) {
        return Effect.fail(
          new Catalog.CallError({ name: "card.update", message: "payload must be { id: string, patch: CardPatch }" })
        )
      }
      if (isRuntimeOwnedCard(store.collections.cards.get(record.id)) || store.approvalRequest(record.id) !== undefined) {
        return Effect.fail(new Catalog.CallError({ name: "card.update", message: "This card is runtime-owned." }))
      }
      return Effect.sync(() => {
        const payload = patch.data.payload
        const untrusted = patch.data.kind === "flow-form" && payload !== undefined
          ? { ...patch.data, payload: { ...patch.data.payload, via: "agent" as const } }
          : patch.data
        emit({ runId, type: "card.update", id: record.id as string, patch: untrusted })
        return { updated: record.id }
      })
    }
  }
]

/** Folds one appended journal event into the wire frames live rendering needs. */
const framesOf = (event: Event.Event, runId: string): ReadonlyArray<AgentTurnFrame> => {
  // Sub-chain events stay journal-only for now: the wire's link numbering is
  // the root chain's, and child rendering is the sub-chains PR's concern.
  if (event.chain !== undefined) return []
  switch (event._tag) {
    case "ChainStarted":
      return []
    case "LinkAuthored":
      return [
        { runId, type: "link.authored", link: event.link, scriptDigest: event.script.digest, script: event.script.text }
      ]
    case "CallSettled":
      return [
        { runId, type: "call.settled", link: event.link, ordinal: event.key.ordinal, name: event.name, verdict: "run" }
      ]
    case "GateRejected":
      return [
        {
          runId,
          type: "gate.rejected",
          link: event.link,
          kind: event.observation.kind,
          message: event.observation.message
        }
      ]
    case "SteeringDrained":
      return [{ runId, type: "steering.drained", link: event.link, count: event.messages.length }]
    case "LinkEnded": {
      const outcome = event.outcome._tag === "Done" ? "done" : event.outcome._tag === "To" ? "to" : "park"
      const ended: AgentTurnFrame = { runId, type: "link.ended", link: event.link, outcome }
      return event.outcome._tag === "Park"
        ? [ended, { runId, type: "park", code: event.outcome.reason.code }]
        : [ended]
    }
  }
}

const teeJournal = (
  inner: Journal.Service,
  emit: Emit,
  runId: string,
  onAppended?: (event: Event.Event) => void
): Journal.Service =>
  Journal.make({
    read: inner.read,
    append: (event, expectedPosition) =>
      inner.append(event, expectedPosition).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            for (const frame of framesOf(event, runId)) emit(frame)
            onAppended?.(event)
          })
        )
      )
  })

export const createChainRuntime = (options: ChainRuntimeOptions): AgentPort => {
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const running = new Map<string, Fiber.Fiber<Outcome.RunResult, unknown>>()
  const steerable = new Map<string, Steering.Service>()
  /* Session-scoped: grants and one-shot denials survive across turns, not reloads. */
  const policy = createChainPolicy()
  /*
   * The background monitor (DESIGN.md §14): a spawned lineage's terminal is
   * delivered wherever the concierge will actually see it — steered into a
   * live turn, or queued for the next turn's context — and always rendered
   * as an honest system message. Goals are kept so an approval-parked
   * background lineage can resume through the same runner.
   */
  const backgroundGoals = new Map<string, { readonly goal: string; readonly context: ReadonlyArray<string> }>()
  const queuedBackgrounds = new Set<string>()
  const activeBackgrounds = new Set<string>()
  const pendingNotes: Array<string> = []

  const emit: Emit = (frame) => {
    for (const listener of listeners) listener(frame)
  }

  const authorLayerOf = () =>
    options.authorLayer ??
      layerAuthor({ baseUrl: options.baseUrl, fetchImpl: options.fetchImpl, modelId: options.modelId })
  /*
   * Model-authored JavaScript runs on the browser main thread. Keep both
   * axes bounded at this production call site: a non-terminating script must
   * be interrupted, and an allocating script must not exhaust the page.
   */
  const runnerLayerOf = () =>
    options.runnerLayer ?? QuickJsRunner.layer({ steps: 100_000, memoryBytes: 16 * 1024 * 1024 })

  const worldview = worldviewEntries(options.store)

  const subPrefix = (): string =>
    Prompt.assemble({
      role: "sub",
      host: hostPrompt("sub"),
      entries: [
        ...Catalog.system,
        ...disclosedEntries(options.commands),
        ...worldview,
        ...(options.entries ?? [])
      ]
    })

  /*
   * Background notes bypass the frame path on purpose: the controller drops
   * frames whose runId is not the active turn, and a background lineage
   * never is. The note renders as a system message now, steers a live turn
   * if one runs, and otherwise waits in pendingNotes for the next turn's
   * harness-built context.
   */
  const deliverNote = (note: string): void => {
    options.store.dispatch({ type: "message.appended", actor: "system", text: note })
    const live = [...steerable.values()][0]
    if (live !== undefined) {
      void Effect.runPromise(live.admit(note) as Effect.Effect<void, never, never>)
    } else {
      pendingNotes.push(note)
    }
  }

  const compactResult = (value: unknown): string => {
    try {
      const rendered = JSON.stringify(value)
      return rendered === undefined ? "" : rendered.length > 200 ? `${rendered.slice(0, 200)}…` : rendered
    } catch {
      return ""
    }
  }

  const runBackground = async (lineage: string): Promise<void> => {
    const spec = backgroundGoals.get(lineage)
    if (spec === undefined) return
    const journalLayer = Layer.succeed(Journal.Journal)(
      makeCollectionJournal({ store: options.store, lineageId: lineage })
    )
    const base = Layer.mergeAll(journalLayer, policy.layerFor(lineage), authorLayerOf(), runnerLayerOf())
    // No surfaces and no background entry: a background tree cannot speak
    // into a turn it does not own, and does not fork further backgrounds.
    const catalog = SubChains.layer({
      entries: [...commandEntries(options.commands, lineage), ...worldview, ...(options.entries ?? [])],
      prefix: subPrefix(),
      maxLinks: options.maxLinks,
      maxCallsPerLink: options.maxCallsPerLink
    }).pipe(Layer.provide(base))
    const program = Chain.run({
      goal: spec.goal,
      context: spec.context,
      prefix: subPrefix(),
      maxLinks: options.maxLinks,
      maxCallsPerLink: options.maxCallsPerLink
    }).pipe(Effect.provide(Layer.mergeAll(base, catalog))) as Effect.Effect<Outcome.RunResult, unknown, never>
    await Effect.runPromise(
      Effect.exit(program) as Effect.Effect<
        { readonly _tag: string; readonly value?: Outcome.RunResult; readonly cause?: unknown },
        never,
        never
      >
    ).then(async (exit) => {
      if (exit._tag !== "Success") {
        // Retirement lives outside the journal: even a gapped or corrupt
        // journal must be durably excluded before its failure is announced.
        await options.store.dispatch({
          type: "chain.lineage.retired", actor: "system", lineageId: lineage
        }).isPersisted.promise
        deliverNote(`A background task failed: ${spec.goal}`)
        backgroundGoals.delete(lineage)
        return
      }
      const outcome = exit.value as Outcome.RunResult
      if (outcome._tag === "Done") {
        const detail = compactResult(outcome.value)
        deliverNote(
          `A background task finished: ${spec.goal}${detail === "" ? "" : ` — ${detail}`}`
        )
        backgroundGoals.delete(lineage)
        return
      }
      if (outcome._tag === "ApprovalWait") {
        const ask = policy.pendingAsk(lineage)
        options.store.dispatch({
          type: "card.upsert",
          actor: "system",
          card: {
            id: `chain-approval-${lineage}`,
            kind: "approval",
            title: "Approval needed",
            status: "active",
            createdAt: Date.now(),
            ordinal: 0,
            payload: {
              capability: ask?.claim ?? "approval",
              detail: ask === undefined ? outcome.reason.message : `A background task wants to run /${ask.name}`,
              runId: lineage,
              chain: true,
              background: true,
              ...(ask === undefined ? {} : { flow: ask.name })
            }
          }
        })
        deliverNote(`A background task is waiting on your approval: ${spec.goal}`)
        return
      }
      /*
       * Script parks are terminal, including park("approval"). Only a
       * policy ApprovalWait can resume through resolveApproval.
       */
      backgroundGoals.delete(lineage)
      deliverNote(`A background task paused (${outcome.reason.code}): ${spec.goal}`)
    })
  }

  /*
   * Fresh intents, recovered backlogs, and approval resumes share one queue.
   * A slot covers the entire run and terminal persistence; approval waits
   * release it while retaining their goal for the human's decision.
   */
  const drainBackgrounds = (): void => {
    for (const lineage of queuedBackgrounds) {
      if (activeBackgrounds.size >= MAX_BACKGROUNDS) break
      queuedBackgrounds.delete(lineage)
      activeBackgrounds.add(lineage)
      void runBackground(lineage).catch((cause) => {
        // A failed retirement receipt must not become a reported, forgotten
        // failure. Keep the goal registered and leave recovery to the next boot.
        console.error("Background completion could not be persisted", cause)
      }).finally(() => {
        activeBackgrounds.delete(lineage)
        drainBackgrounds()
      })
    }
  }

  const enqueueBackground = (lineage: string): void => {
    if (!backgroundGoals.has(lineage) || activeBackgrounds.has(lineage)) return
    queuedBackgrounds.add(lineage)
    queueMicrotask(drainBackgrounds)
  }

  /** The concierge's door to unattended work: spawn now, hear back later. */
  const backgroundEntry: Catalog.Entry = {
    name: "background",
    description:
      "Start a background sub-agent that works while you answer. Payload: { goal: string, context?: string[] }. Returns { lineage } immediately; its result arrives later as a note.",
    capabilities: [SubChains.agentCapability],
    handler: (payload) => {
      const decoded = decodeBackground(payload)
      if (Option.isNone(decoded) || decoded.value.goal === "") {
        return Effect.fail(
          new Catalog.CallError({ name: "background", message: `"background" takes { goal, context? }` })
        )
      }
      const { goal, context = [] } = decoded.value
      return Effect.sync(() => {
        // Nondeterminism is fine here: the settled result journals the
        // lineage id, so replay returns it without spawning again.
        const lineage = `bg-${crypto.randomUUID()}`
        backgroundGoals.set(lineage, { goal, context })
        /*
         * The child may start only after the parent's CallSettled append is
         * durable. A crash before that append therefore leaves no child
         * history, while boot reconciliation below can launch a committed
         * intent that crashed before this continuation ran.
         */
        return { lineage }
      })
    }
  }

  /*
   * Boot reconciliation: a reload must not orphan background work. The
   * Parent intents own the goal and context; child events own terminal state.
   * Collection iteration is not journal order, so neither can overwrite the
   * other and root terminals are selected by sequence. Policy approval waits
   * have no LinkEnded; every recorded Done or Park is terminal.
   */
  const resumeBackgrounds = (): void => {
    const byLineage = new Map<string, {
      spec: typeof BackgroundSpec.Type | undefined
      hasIntent: boolean
      terminalSeq: number
      done: boolean
    }>()
    const entryFor = (lineage: string) => {
      const entry = byLineage.get(lineage) ?? { spec: undefined, hasIntent: false, terminalSeq: -1, done: false }
      byLineage.set(lineage, entry)
      return entry
    }
    for (const record of options.store.collections.chainEvents.values()) {
      const event = record.event as {
        readonly _tag: string
        readonly chain?: string
        readonly goal?: string
        readonly name?: string
        readonly payload?: unknown
        readonly result?: { readonly lineage?: unknown }
        readonly outcome?: { readonly _tag?: string }
      }
      if (
        event._tag === "CallSettled" &&
        event.name === "background" &&
        typeof event.result?.lineage === "string" &&
        event.result.lineage.startsWith("bg-")
      ) {
        const entry = entryFor(event.result.lineage)
        entry.hasIntent = true
        entry.spec = Option.getOrUndefined(decodeBackground(event.payload))
      }
      if (!record.lineageId.startsWith("bg-")) continue
      const entry = entryFor(record.lineageId)
      if (event._tag === "ChainStarted" && (event.chain ?? "") === "" && !entry.hasIntent) {
        entry.spec = { goal: event.goal ?? "", context: [] }
      }
      if (event._tag === "LinkEnded" && (event.chain ?? "") === "" && record.seq > entry.terminalSeq) {
        entry.terminalSeq = record.seq
        entry.done = event.outcome?._tag === "Done" || event.outcome?._tag === "Park"
      }
    }
    for (const [lineage, entry] of byLineage) {
      if (entry.done || backgroundGoals.has(lineage) ||
        options.store.collections.retiredChainLineages.has(retiredLineageKey(lineage))) continue
      // A malformed parent intent must not run with silently discarded context.
      if (entry.spec === undefined || entry.spec.goal === "") continue
      backgroundGoals.set(lineage, { goal: entry.spec.goal, context: entry.spec.context ?? [] })
      const card = options.store.collections.cards.get(`chain-approval-${lineage}`)
      const awaitingDecision = card?.kind === "approval" && card.status !== "acted"
      if (!awaitingDecision) enqueueBackground(lineage)
    }
  }
  resumeBackgrounds()

  const startTurn = async (request: StartAgentTurnRequest) => {
    if (running.has(request.runId)) {
      return { status: "error", message: "That Smithers turn is already running." } as const
    }

    const commandCatalog = commandEntries(options.commands, request.runId)
    const surfaces = surfaceEntries(emit, request.runId, options.store)
    const host = options.entries ?? []
    const treeEntries = [...commandCatalog, ...surfaces, ...worldview, ...host, backgroundEntry]
    const agentDisclosure: Catalog.Entry = {
      name: SubChains.agentName,
      description: SubChains.agentDescription,
      handler: () => Effect.succeed(undefined)
    }
    const prefix = Prompt.assemble({
      role: "concierge",
      host: hostPrompt("concierge"),
      entries: [
        ...Catalog.system,
        ...disclosedEntries(options.commands),
        ...surfaces,
        ...worldview,
        ...host,
        backgroundEntry,
        agentDisclosure
      ]
    })

    const journalLayer = Layer.succeed(Journal.Journal)(
      teeJournal(
        makeCollectionJournal({ store: options.store, lineageId: request.runId }),
        emit,
        request.runId,
        (event) => {
          if (
            event._tag === "CallSettled" &&
            event.name === "background" &&
            typeof (event.result as { readonly lineage?: unknown }).lineage === "string"
          ) {
            enqueueBackground((event.result as { readonly lineage: string }).lineage)
          }
        }
      )
    )
    /*
     * The turn's steering queue lives OUTSIDE the layer stack so steer()
     * can admit while the chain runs; the chain drains it at live author
     * boundaries and journals the drain (SteeringDrained → the frame).
     * In-memory stand-in, same loss window as the chain's own layerMemory.
     */
    const queue = Effect.runSync(Ref.make<ReadonlyArray<string>>([]))
    const steering = Steering.make({
      admit: (message) => Ref.update(queue, (pending) => [...pending, message]),
      drain: () => Ref.getAndSet(queue, [])
    })
    steerable.set(request.runId, steering)
    const base = Layer.mergeAll(
      journalLayer,
      Layer.succeed(Steering.Steering)(steering),
      policy.layerFor(request.runId),
      authorLayerOf(),
      runnerLayerOf()
    )
    /*
     * SubChains owns the tree's catalog: the given entries plus the
     * recursive agent entry and the system entries, with reserved names
     * enforced at construction. Inline children share this catalog — a
     * child may say into the turn it runs under; backgrounds do not.
     */
    const layers = Layer.mergeAll(
      base,
      SubChains.layer({
        entries: treeEntries,
        prefix: subPrefix(),
        maxLinks: options.maxLinks,
        maxCallsPerLink: options.maxCallsPerLink
      }).pipe(Layer.provide(base))
    )

    const program = Chain.run({
      goal: goalOf(request.messages),
      prefix,
      context: [
        ...contextLines(request.messages),
        ...pendingNotes.splice(0).map((note) => `[background] ${note}`)
      ],
      maxLinks: options.maxLinks,
      maxCallsPerLink: options.maxCallsPerLink
    }).pipe(Effect.provide(layers)) as Effect.Effect<Outcome.RunResult, unknown, never>

    const fiber = Effect.runFork(program)
    running.set(request.runId, fiber)
    void Effect.runPromise(Fiber.await(fiber)).then((exit) => {
      running.delete(request.runId)
      steerable.delete(request.runId)
      if (Exit.isSuccess(exit)) {
        const outcome = exit.value
        if (outcome._tag === "ApprovalWait") {
          /*
           * An approval park ends the turn awaiting the human: the card
           * is registered directly by the runtime, the park frame names the
           * suspension, and resolveApproval + a fresh startTurn on the
           * same lineage resumes from the settled prefix and re-asks.
           */
          const ask = policy.pendingAsk(request.runId)
          options.store.dispatch({
            type: "card.upsert",
            actor: "system",
            card: {
              id: `chain-approval-${request.runId}`,
              kind: "approval",
              title: "Approval needed",
              status: "active",
              createdAt: Date.now(),
              ordinal: 0,
              payload: {
                capability: ask?.claim ?? "approval",
                detail: ask === undefined
                  ? outcome.reason.message
                  : `Smithers wants to run /${ask.name}`,
                runId: request.runId,
                chain: true,
                ...(ask === undefined ? {} : { flow: ask.name })
              }
            }
          })
          emit({ runId: request.runId, type: "park", code: "approval" })
        }
        emit({ runId: request.runId, type: "done", reason: "stop" })
        return
      }
      const { cause } = exit
      // A late stop cannot cancel an already settled approval boundary.
      if (Cause.hasInterruptsOnly(cause)) {
        emit({ runId: request.runId, type: "done", reason: "cancelled" })
        return
      }
      emit({
        runId: request.runId,
        type: "done",
        error: `The chain failed: ${String(cause)}`
      })
    })
    return { status: "started" } as const
  }

  return {
    available: true,
    startTurn,
    cancelTurn: async (runId) => {
      const fiber = running.get(runId)
      if (fiber === undefined) return
      await Effect.runPromise(Fiber.interrupt(fiber) as Effect.Effect<unknown, never, never>)
    },
    steer: async (runId, text) => {
      const steering = steerable.get(runId)
      if (steering === undefined) return false
      await Effect.runPromise(steering.admit(text) as Effect.Effect<void, never, never>)
      return true
    },
    resolveApproval: async (runId, decision, ask) => {
      const resolved = policy.resolve(runId, decision, ask)
      // A background lineage resumes through its own runner — no turn
      // lifecycle to re-enter; the controller only freezes the card.
      if (resolved && backgroundGoals.has(runId)) {
        enqueueBackground(runId)
      }
      return resolved
    },
    revokeGrants: async () => policy.revoke(),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

/*
 * The agent seat: one AgentPort the controller holds, delegating every turn
 * to the browser chain.
 *
 * The indirection is a binding order, not a choice of backend — the chain's
 * catalog IS the controller's command registry, so the chain cannot be built
 * until the controller exists, and the controller needs an agent to be built
 * at all. The native shell's own agent stays the fallback: it is a different
 * HOST for the same loop, not a second backend. On the web there is no
 * fallback, and a turn before the chain binds says so rather than pretending.
 */
export const createAgentSeat = (
  native?: AgentPort
): AgentPort & { readonly bindChain: (chain: AgentPort) => void } => {
  const listeners = new Set<(frame: AgentTurnFrame) => void>()
  const startedBy = new Map<string, AgentPort>()
  const parked = new Set<string>()
  let chain: AgentPort | undefined

  const forward = (frame: AgentTurnFrame): void => {
    if (frame.type === "park" && frame.code === "approval") parked.add(frame.runId)
    if (frame.type === "done") {
      const waiting = parked.delete(frame.runId)
      if (!waiting || frame.reason === "cancelled" || frame.error !== undefined) startedBy.delete(frame.runId)
    }
    for (const listener of listeners) listener(frame)
  }
  if (native !== undefined) native.subscribe(forward)

  const unbound: AgentPort = {
    available: false,
    startTurn: async () => ({ status: "error", message: "Smithers is still starting up." }) as const,
    cancelTurn: async () => {},
    subscribe: () => () => {}
  }

  const current = (): AgentPort => chain ?? native ?? unbound

  return {
    available: true,
    startTurn: async (request) => {
      // A resume reuses its lineage's runId: route it to the agent that
      // started the run.
      const previous = startedBy.get(request.runId)
      const backend = previous ?? current()
      startedBy.set(request.runId, backend)
      try {
        const result = await backend.startTurn(request)
        if (result.status !== "started" && previous === undefined) startedBy.delete(request.runId)
        return result
      } catch (error) {
        if (previous === undefined) startedBy.delete(request.runId)
        throw error
      }
    },
    cancelTurn: async (runId) => {
      // The terminal frame owns cleanup; a late cancel may leave a park intact.
      await (startedBy.get(runId) ?? current()).cancelTurn(runId)
    },
    steer: async (runId, text) => {
      const backend = startedBy.get(runId) ?? current()
      return backend.steer === undefined ? false : backend.steer(runId, text)
    },
    resolveApproval: async (runId, decision, ask) => {
      // Background lineages never pass through startTurn, so the chain is
      // preferred over whatever last started a run.
      const backend = startedBy.get(runId) ?? chain ?? current()
      return backend.resolveApproval === undefined
        ? false
        : backend.resolveApproval(runId, decision, ask)
    },
    revokeGrants: async () => {
      if (chain?.revokeGrants !== undefined) await chain.revokeGrants()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    bindChain: (bound) => {
      chain = bound
      bound.subscribe(forward)
    }
  }
}
