/*
 * The registry runtime: one dispatch path for every trigger.
 *
 * Every interactive affordance in the app is a registered flow, and every
 * trigger — button, pill, slash menu, agent call — resolves to the SAME
 * `FlowBinding` and invokes it the same way. Launch law: a button with no flow
 * behind it is a launch blocker (parity.test.ts gates this).
 *
 * The catalog disclosed to the agent is not a second projection of this
 * registry; it is this registry narrowed to model-invocable entries, and the
 * same bindings answer the calls. That is why `CommandCatalog.ts` no longer
 * exists: a parallel projection is exactly the drift the one-door law forbids.
 */
import { Authorize } from "@smthrs/chain"
import { FlowCancellation } from "./FlowCancellation"
import type { AgentInvocation } from "./AgentInvocation"
import { createChainPolicy } from "../chain/Policy"
import { formFlows } from "./entries/form"
import * as Cell from "@smthrs/harness/Cell"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import { Effect } from "effect"
import { hasCapability } from "@smthrs/rpc/AppBootstrap"
import type { AgentToolCall, AgentToolSpec } from "./agentTools"
import { agentFailureText, agentToolSpecs, executeAgentToolCall, userOnlyError } from "./agentTools"
import type { AppTransition } from "../state/AppState"
import type { CommandActions } from "./Flows"
import { adminFlows, baseFlows } from "./Flows"
import { repositoryFlowLeaves } from "./entries/flow"
import type { CatalogItem, CommandState, FlowEntry, MissingDoor, SlashItem, SlashRow } from "./registry"
import {
  absentDoor,
  confirmLabel,
  flowRequirements,
  itemOf,
  modelInvocable,
  nameOf,
  namespaceOf,
  recommendedNames,
  slashItems,
  slashTree,
  unmetRequirements,
  visible
} from "./registry"
import { payloadFor } from "./SlashPayload"

export type { CommandActions, CommandResult } from "./Flows"

export type CommandOutcome =
  | { readonly status: "executed"; readonly value?: string }
  /** A name no host has. */
  | { readonly status: "unknown-command" }
  /**
   * A declared flow this host lacks the door for (`explainAbsent`): `reason`
   * is the one sentence every trigger says. When the native app is the answer
   * (`door` local or cloud.pat) the registry has already rendered the refusal
   * card through the named action; for the other doors nothing is rendered
   * and the sentence is the whole answer.
   */
  | {
    readonly status: "unavailable"
    readonly door: AbsentDoor
    readonly reason: string
    readonly action: "app.download.prompt" | null
  }
  | { readonly status: "failed"; readonly error: string }
  /**
   * THE FORM LAW (apps/ui/AGENTS.md): the invocation lacked required input,
   * so nothing ran and the flow's form card is rendered instead — prefilled
   * from what the line gave, asking for `fields`. Only the agent and slash
   * doors reach this; a button always carries its args.
   */
  | { readonly status: "form"; readonly flow: string; readonly cardId: string; readonly fields: ReadonlyArray<string> }

/**
 * The door classes an exact miss resolves to. `cloud.session` refines
 * `cloud.pat`: the flows that ARE the PAT session (the `cloud.` namespace),
 * which on the web the GitHub sign-in already answers.
 */
export type AbsentDoor = MissingDoor | "cloud.session"

export interface AbsentExplanation {
  readonly door: AbsentDoor
  /** The one sentence every trigger says. */
  readonly reason: string
}

/** Whether the native app is the answer to a miss of this door: the refusal card carries the download. */
export const downloadAnswers = (door: AbsentDoor): boolean => door === "local" || door === "cloud.pat"

/** The sentence a miss of each door gets, after the flow it names. */
export const absentReason = (name: string, door: AbsentDoor): string => {
  switch (door) {
    case "local":
      return `/${name} is not in the web app — it needs the native app.`
    case "cloud.pat":
      return `/${name} is not in the web app — it needs the native app's Smithers Cloud session.`
    case "cloud.session":
      return `/${name} is not in the web app — on the web your GitHub sign-in is your Smithers Cloud sign-in.`
    case "origin":
      return `/${name} is not available on this origin yet.`
  }
}

/** The flow the registry renders for a native-only miss on the web. */
const DOWNLOAD_PROMPT = "app.download.prompt"

export interface CommandRegistry {
  /** Every registered flow as UI-catalog records, admin entries included only for admin sessions. */
  readonly all: () => ReadonlyArray<CatalogItem>
  /** The same flows as executable entries. */
  readonly entries: () => ReadonlyArray<FlowEntry>
  readonly find: (name: string) => FlowEntry | undefined
  /**
   * Why an exact name is absent from THIS host, classified against the
   * unfiltered catalog by the door the host lacks (registry.ts `absentDoor`):
   * the native app (`local`, `cloud.pat`), the session flows the GitHub
   * sign-in already answers on the web (`cloud.session`), or a door this
   * origin could grow (`origin`). Undefined for a present flow, for a name no
   * host has, and for a flow about the other host. A prerequisite (sign-in)
   * is never a reason here — it is the requirement axis, resolved by `run`.
   */
  readonly explainAbsent: (name: string) => AbsentExplanation | undefined
  readonly state: () => CommandState
  readonly slashItems: (needle: string) => Array<SlashItem<CatalogItem>>
  /** The slash menu as a tree: leaves and namespace rows (registry.slashTree). */
  readonly slashTree: (needle: string) => Array<SlashRow<CatalogItem>>
  readonly recommended: () => CatalogItem
  readonly run: (name: string, args?: string) => Promise<CommandOutcome>
  /**
   * `run` at the agent boundary (requirement axis): an unmet requirement is an
   * honest failure carrying the reason — never a deferral, because a model must
   * not enqueue work that fires after its turn ends.
   */
  readonly runAsAgent: (name: string, args?: string) => Promise<CommandOutcome>
  /**
   * The agent's entry point: one call through the identical run path buttons
   * and slash use. The result is an honest string that round-trips to the model.
   */
  readonly executeForAgent: (call: AgentToolCall) => Promise<string>
  /**
   * One flow as the agent actor, answered as a TYPED outcome. The string
   * channel executeForAgent returns cannot distinguish a failure from a success
   * value that happens to start with a failure prefix; this path never sniffs
   * strings.
   */
  readonly runForAgent: (name: string, args?: string, invocation?: AgentInvocation, signal?: AbortSignal) => Promise<CommandOutcome>
  /** The flows the agent may call: the registry narrowed to model-invocable entries. */
  readonly callable: () => ReadonlyArray<FlowEntry>
  /** What the prompt's catalog block teaches: callable flows that are not hidden. */
  readonly disclosed: () => ReadonlyArray<Descriptor.FlowDescriptor>
  readonly toolSpecs: () => ReadonlyArray<AgentToolSpec>
}

/**
 * Chain calls carry their lineage, script digest and ordinal into the binding
 * so a handler opening a durable boundary can key it to the same invocation.
 * Buttons and slash calls have no replay frame and retain the app identity.
 */
const callFor = (entry: FlowEntry, payload: Record<string, unknown>, invocation?: AgentInvocation): Cell.Call =>
  new Cell.Call({
    flowName: nameOf(entry),
    input: payload as Cell.Call["input"],
    capabilities: entry.binding.descriptor.capabilities,
    effects: entry.binding.descriptor.effects,
    placement: entry.binding.descriptor.placement,
    identity: new Cell.CallIdentity({
      session: invocation?.lineage === undefined ? "app" : `${invocation.lineage}/${invocation.slot.chain}`,
      frame: invocation?.slot.link ?? 0,
      cell: invocation?.slot.key?.scriptDigest ?? "app",
      ordinal: invocation?.slot.ordinal ?? 0,
      declaration: Cell.declarationDigest(entry.binding.descriptor),
      layers: []
    })
  })

/*
 * FlowBinding frames a handler refusal for the cell that will read it next
 * ("Flow x failed: …"). The app surfaces the same refusal to a human, where the
 * frame is noise, so the deterministic prefix comes back off. See
 * LIBRARY-CHANGE-REQUESTS.md — the honest fix is for CallResult to carry the
 * raw message beside the framed one.
 */
const unframe = (name: string, message: string | undefined): string => {
  if (message === undefined || message === `Flow ${name} failed.`) return `/${name} failed`
  const failed = `Flow ${name} failed: `
  if (message.startsWith(failed)) return message.slice(failed.length)
  return message
}

/** The one string an app flow's success may carry back to the model. */
const valueOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const carried = (value as { readonly value?: unknown }).value
  return typeof carried === "string" ? carried : undefined
}

export const createCommandRegistry = (actions: CommandActions, agentActions: CommandActions = actions): CommandRegistry => {
  const defaultPolicy = createChainPolicy().layerFor("app")
  const unscopedInvocation: AgentInvocation = {
    slot: { chain: "app", link: 0, ordinal: 0 },
    authorize: Authorize.make({
      authorize: (request) => Effect.flatMap(Authorize.Authorize, (service) => service.authorize(request)).pipe(
        Effect.provide(defaultPolicy)
      )
    }),
    refused: () => {}
  }
  const base = baseFlows(actions)
  const admin = adminFlows(actions)
  /*
   * The repository's own flows, derived from its factory projection each
   * time the projection lands (entries/flow.ts `repositoryFlowLeaves`) and
   * gone with it. Cached on the row's identity because the slash tree reads
   * the registry per keystroke. A declared flow keeps its name: a projection
   * row that shares one (`chat`, `flow.list`) gets no leaf, so no name ever
   * resolves to two entries.
   */
  let leafCache: { readonly repo: string; readonly loadedAt: number; readonly leaves: ReadonlyArray<FlowEntry> } | undefined
  const leaves = (): ReadonlyArray<FlowEntry> => {
    const catalog = actions.repositoryFlows()
    if (catalog === undefined) return []
    if (leafCache !== undefined && leafCache.repo === catalog.repo && leafCache.loadedAt === catalog.loadedAt) return leafCache.leaves
    const taken = new Set([...base, ...admin].map(nameOf))
    const built = repositoryFlowLeaves(actions, catalog.repo, catalog.flows).filter((entry) => !taken.has(nameOf(entry)))
    leafCache = { repo: catalog.repo, loadedAt: catalog.loadedAt, leaves: built }
    return built
  }
  let agentEntries: ReadonlyArray<FlowEntry> | undefined
  const agentEntry = (name: string): FlowEntry | undefined => {
    agentEntries ??= agentActions === actions ? [...base, ...admin] : [...baseFlows(agentActions), ...adminFlows(agentActions)]
    const declared = agentEntries.find((candidate) => nameOf(candidate) === name)
    if (declared !== undefined) return declared
    if (agentActions === actions) return leaves().find((candidate) => nameOf(candidate) === name)
    const catalog = agentActions.repositoryFlows()
    return catalog === undefined
      ? undefined
      : repositoryFlowLeaves(agentActions, catalog.repo, catalog.flows).find((candidate) => nameOf(candidate) === name)
  }

  const available = (entry: FlowEntry): boolean => {
    const bootstrap = actions.bootstrap
    const { hosts } = entry.metadata
    // A host-scoped flow exists only where the bootstrap names its host: no bootstrap, no host, no flow.
    if (hosts !== undefined && (bootstrap === undefined || !hosts.includes(bootstrap.host))) return false
    if (bootstrap === undefined) return true
    const { runtime = [], runtimeAny } = entry.metadata
    return runtime.every((capability) => hasCapability(bootstrap, capability)) &&
      (runtimeAny === undefined || runtimeAny.some((capability) => hasCapability(bootstrap, capability)))
  }

  const entries = (): ReadonlyArray<FlowEntry> =>
    [...(actions.snapshot().admin ? [...base, ...admin] : base), ...leaves()].filter(available)

  const items = (): ReadonlyArray<CatalogItem> => entries().map(itemOf)

  const find = (name: string): FlowEntry | undefined => entries().find((entry) => nameOf(entry) === name)

  /*
   * The honest refusal (docs/web-mode/PLAN.md §1). The enabled catalog stays
   * the only executable surface; an exact miss is classified against the
   * UNFILTERED declarations by the door this bootstrap lacks, so the flow is
   * never reported as nonexistent when it is this origin that lacks the door.
   * Only a name absent from the declarations stays unknown-command.
   */
  const explainAbsent = (name: string): AbsentExplanation | undefined => {
    const bootstrap = actions.bootstrap
    if (bootstrap === undefined || find(name) !== undefined) return undefined
    const declared = base.find((entry) => nameOf(entry) === name) ?? leaves().find((entry) => nameOf(entry) === name)
    if (declared === undefined) return undefined
    const missing = absentDoor(declared.metadata, bootstrap)
    if (missing === undefined) return undefined
    const door: AbsentDoor = missing === "cloud.pat" && namespaceOf(name) === "cloud" ? "cloud.session" : missing
    return { door, reason: absentReason(name, door) }
  }

  /** Invokes one flow through its binding — the single door every trigger shares. */
  const invoke = async (
    entry: FlowEntry,
    payload: Record<string, unknown>,
    invocation?: AgentInvocation
  ): Promise<CommandOutcome> => {
    const name = nameOf(entry)
    const settled = await Effect.runPromise(
      Effect.result(entry.binding.run(callFor(entry, payload, invocation))).pipe(
        Effect.provideService(FlowCancellation, invocation?.signal)
      ),
      // Controller promises receive the signal but retain their result when a
      // write cannot abort. Effect-native bindings use fiber interruption.
      { signal: entry.cooperativeCancellation === true ? undefined : invocation?.signal }
    )
    if (settled._tag === "Failure") {
      // A permission park or an assembly failure is not the human's business
      // to catch; surfaced honestly, it is still a failed invocation.
      return { status: "failed", error: unframe(name, settled.failure.message) }
    }
    const result = settled.success
    if (result.outcome === "failure") {
      return { status: "failed", error: unframe(name, result.message) }
    }
    const value = valueOf(result.value)
    return value === undefined ? { status: "executed" } : { status: "executed", value }
  }

  /**
   * The one execution path every trigger (button, pill, slash, agent) shares.
   * The requirement axis resolves FIRST: a user-invoked flow with an unmet
   * requirement parks durably (actions.deferCommand) and the requirement's
   * fulfilling flow runs in its place — the controller resumes the parked flow
   * when the requirement's predicate flips true. Requirements resolve one at a
   * time against live state, so a flow needing sign-in AND a repo selection
   * steps through both. `seen` guards a misconfigured requirement table (a
   * fulfill cycle) with an honest failure instead of recursion.
   */
  /*
   * The /verbose trace: every invocation that passes this door is recorded
   * as one `flow.invoked` transition — actor, name, args, outcome, duration —
   * whichever trigger sent it and whether or not the flow is listed. The
   * store renders the record only while verbose is on.
   */
  const trace = (
    invoker: "user" | "agent",
    name: string,
    args: string | undefined,
    startedAt: number,
    outcome: Extract<AppTransition, { type: "flow.invoked" }>["outcome"],
    detail: string | null
  ): void => {
    // Diagnostics are persisted even with verbose off. Keep execution input
    // untouched, but never hand environment or form values to the trace sink.
    let tracedArgs = args ?? null
    if (args !== undefined && (name === "env.set" || name === "form.set")) {
      const parsed = payloadFor(name, args, undefined, actions.knownRepositories())
      tracedArgs = "[REDACTED]"
      if (!("error" in parsed)) {
        if (name === "env.set" && typeof parsed.payload.assignment === "string") {
          const variable = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(parsed.payload.assignment)?.[1]
          if (variable !== undefined) {
            tracedArgs = `${variable}=[REDACTED]${typeof parsed.payload.repo === "string" ? ` ${parsed.payload.repo}` : ""}`
          }
        } else if (name === "form.set") {
          // Form schemas have no sensitivity declaration yet. Mask every
          // value, including arbitrary card/field targets, without guessing.
          tracedArgs = `${parsed.payload.cardId} ${parsed.payload.field} [REDACTED]`
        }
      }
    }
    // Both errors and success text can echo input; form.submit also carries
    // the nested flow's assembled arguments even though its own args are an id.
    const sensitive = name === "env.set" || name === "form.set" || name === "form.submit"
    actions.traceFlow({
      type: "flow.invoked",
      actor: invoker === "agent" ? "smithers" : "user",
      name,
      args: tracedArgs,
      hidden: find(name)?.metadata.hidden === true,
      outcome,
      detail: sensitive && detail ? "[REDACTED]" : detail,
      durationMs: Math.max(0, Math.round(Date.now() - startedAt))
    })
  }

  const runAs = async (
    invoker: "user" | "agent",
    name: string,
    args?: string,
    seen: ReadonlySet<string> = new Set(),
    invocation?: AgentInvocation
  ): Promise<CommandOutcome> => {
    invocation?.signal?.throwIfAborted()
    const startedAt = Date.now()
    const outcome = await settle(invoker, name, args, seen, startedAt, invocation)
    trace(
      invoker,
      name,
      args,
      startedAt,
      // The trace's outcome vocabulary predates the host boundary: an unavailable flow is recorded as the miss it is, with the reason as its detail.
      outcome.status === "unavailable" ? "unknown-command" : outcome.status,
      outcome.status === "failed"
        ? outcome.error
        : outcome.status === "unavailable"
        ? outcome.reason
        : outcome.status === "form"
        ? `rendered a form for ${outcome.fields.join(", ")}`
        : outcome.status === "executed"
        ? outcome.value ?? null
        : null
    )
    return outcome
  }

  const settle = async (
    invoker: "user" | "agent",
    name: string,
    args: string | undefined,
    seen: ReadonlySet<string>,
    startedAt: number,
    invocation?: AgentInvocation
  ): Promise<CommandOutcome> => {
    const entry = find(name)
    if (entry === undefined) {
      const absent = explainAbsent(name)
      if (absent === undefined) return { status: "unknown-command" }
      const { door, reason } = absent
      if (!downloadAnswers(door)) return { status: "unavailable", door, reason, action: null }
      /*
       * The refusal IS the download card: rendered here, through the prompt
       * flow's own binding, so slash, button and agent get the same card and
       * none of them has to know to ask for it. Invoked directly rather than
       * through runAs: the human did not run app.download.prompt, the app did,
       * so it neither ranks in their recent commands nor traces as their act.
       */
      const prompt = find(DOWNLOAD_PROMPT)
      if (prompt !== undefined) await invoke(prompt, { flow: name }, invocation)
      return { status: "unavailable", door, reason, action: DOWNLOAD_PROMPT }
    }
    let target = invoker === "agent" ? agentEntry(nameOf(entry)) ?? entry : entry
    if (invoker === "agent" && !modelInvocable(target)) {
      return { status: "failed", error: userOnlyError(nameOf(target), target.metadata.userOnlyReason) }
    }
    const acting = invoker === "agent" ? agentActions : actions
    const unmet = unmetRequirements(target.metadata, actions.snapshot(), flowRequirements)[0]
    if (unmet !== undefined) {
      if (invoker === "agent") {
        /*
         * The machinery renders the missing sign-in step ITSELF — a model told
         * about auth.prompt sometimes writes the name as prose instead of
         * invoking it, and prose is not a button.
         */
        if (unmet.id === "signed-in") {
          acting.promptSignIn()
          return {
            status: "failed",
            error: `${unmet.reason} — the sign-in step is already rendered in the chat; point the user at it`
          }
        }
        return { status: "failed", error: `${unmet.reason} — /${nameOf(target)} waits on that` }
      }
      if (seen.has(unmet.fulfill)) {
        return {
          status: "failed",
          error: `${unmet.reason} — and /${unmet.fulfill} could not fulfill it`
        }
      }
      actions.deferCommand(nameOf(target), args ?? null, unmet.id)
      // The deferral is its own trace; the fulfilling flow traces itself below.
      trace(invoker, name, args, startedAt, "deferred", `waits on ${unmet.id}`)
      return runAs("user", unmet.fulfill, undefined, new Set([...seen, unmet.fulfill]))
    }
    /*
     * The composer boundary: argument text becomes the flow's typed payload
     * exactly once, here, and a text that cannot be parsed is refused before
     * the binding runs.
     */
    const parsed = payloadFor(nameOf(target), args, target.metadata.grammar, actions.knownRepositories())
    if ("error" in parsed) {
      /*
       * THE FORM LAW: a line without the flow's required input renders the
       * flow's form — derived from its input schema, prefilled with what the
       * line gave — and nothing else. No door answers with a usage sentence;
       * the grammar's own reason stays the fallback only for a flow with no
       * fields to ask for (none today).
       */
      const rendered = acting.renderFlowForm({
        name: nameOf(target),
        args,
        via: invoker,
        invocation: invocation === undefined ? undefined : { ...invocation, authorized: undefined, signal: undefined },
        input: target.input,
        ...(target.metadata.form === undefined ? {} : { hints: target.metadata.form })
      })
      if (rendered === undefined) return { status: "failed", error: parsed.error }
      return { status: "form", flow: nameOf(target), cardId: rendered.cardId, fields: rendered.missing }
    }
    /*
     * A `confirm` flow asked for by the MODEL: consequential acts (land a
     * PR, remove a credential, launch a harness) are invocable by the agent
     * — every listed flow is — but never performed by it. The invocation
     * posts a confirmation message whose button runs the flow as the user.
     * The label may depend on the payload (registry.ts `confirm`).
     */
    const confirmation = invoker === "agent" ? confirmLabel(target.metadata, parsed.payload) : undefined
    if (confirmation !== undefined) {
      acting.requestFlowConfirmation(nameOf(target), args ?? null, confirmation)
      trace(invoker, name, args, startedAt, "confirm-requested", confirmation)
      return {
        status: "executed",
        value:
          `asked the user to confirm "/${nameOf(target)}${args === undefined ? "" : ` ${args}`}" — it runs only when they confirm, and nothing has happened yet`
      }
    }
    if (invoker === "agent") {
      if (invocation !== undefined && invocation.authorized !== Cell.declarationDigest(target.binding.descriptor)) {
        const request = {
          name: nameOf(target),
          capabilities: target.binding.descriptor.capabilities,
          slot: invocation.slot
        }
        const authorization = invocation.authorize.authorize(request)
        const decision = await Effect.runPromise(Effect.result(authorization), { signal: invocation.signal })
        if (decision._tag === "Failure") {
          invocation.refused(decision.failure)
          return { status: "failed", error: decision.failure.message }
        }
      }
      // Bind this continuation explicitly. No shared mutable actor or authority
      // can leak into another concurrent command, and card metadata grants nothing.
      if (nameOf(target) === "form.submit") {
        const continuation = invocation === undefined ? unscopedInvocation : { ...invocation, authorized: undefined }
        target = formFlows(acting, continuation).find((candidate) => nameOf(candidate) === "form.submit")!
      }
    }
    invocation?.signal?.throwIfAborted()
    const settledOutcome = await invoke(target, parsed.payload, invocation)
    /*
     * The agent reads a refusal as its next act: a handler that points the
     * human at a slash the model cannot run (`/cloud.sign-in`) points the
     * model at the prompt flow that renders that button instead.
     */
    const outcome: CommandOutcome = invoker === "agent" && settledOutcome.status === "failed"
      ? { status: "failed", error: agentFailureText(settledOutcome.error) }
      : settledOutcome
    // A successful, user-invoked, LISTED flow feeds the slash menu's recency
    // ranking; hidden id-scoped acts never rank.
    if (outcome.status === "executed" && invoker === "user" && target.metadata.hidden !== true) {
      actions.noteCommandRun(nameOf(target))
    }
    return outcome
  }

  const run = (name: string, args?: string): Promise<CommandOutcome> => runAs("user", name, args)

  const callable = (): ReadonlyArray<FlowEntry> => entries().filter(modelInvocable)

  const registry: CommandRegistry = {
    all: items,
    entries,
    find,
    explainAbsent,
    state: actions.snapshot,
    slashItems: (needle) => slashItems(actions.snapshot(), needle, items()),
    slashTree: (needle) => slashTree(actions.snapshot(), needle, items()),
    recommended: () => {
      const name = recommendedNames(actions.snapshot())[0]
      const command = name === undefined ? undefined : items().find((item) => item.name === name)
      if (command === undefined) throw new Error("The recommended flow is not registered")
      return command
    },
    run,
    // Preserve the native host's direct tool path. Form continuations
    // still enter runForAgent below and must bring authority or fail closed.
    runAsAgent: (name, args) => runAs("agent", name, args),
    executeForAgent: (call) => executeAgentToolCall(registry, call),
    runForAgent: async (name, args, invocation, signal) => {
      const clean = name.trim().replace(/^\/+/, "")
      const target = find(clean)
      if (target !== undefined && !modelInvocable(target)) {
        return { status: "failed", error: userOnlyError(clean, target.metadata.userOnlyReason) }
      }
      return runAs("agent", clean, args, new Set(), {
        ...(invocation ?? unscopedInvocation),
        signal: signal ?? invocation?.signal
      })
    },
    callable,
    /*
     * Callable vs disclosed mirrors the tool contract exactly: the agent may
     * EXECUTE every model-invocable flow (hidden id-scoped actions like
     * world.new-note included — hidden means unlisted to the human, not barred
     * to the agent), while the DISCLOSED set the prompt's catalog block
     * teaches is the unhidden subset.
     */
    disclosed: () =>
      callable()
        .filter((entry) => entry.metadata.hidden !== true)
        .map((entry) => entry.binding.descriptor),
    toolSpecs: () => agentToolSpecs
  }
  return registry
}

/** Re-exported so surfaces can name the catalog record without reaching for registry.ts. */
export type { CatalogItem } from "./registry"

/** The visible catalog, for the "/flows" answer and the slash menu. */
export const visibleItems = (registry: CommandRegistry): Array<CatalogItem> => visible(registry.all())
