import { cloudFailure } from "../seams/CloudClient"
import { renderPlanLimit } from "../seams/BillingSeam"
import { preparedView, type ViewAction } from "../PreparedView"
import { WORKFLOW_PROVISION_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { Card } from "../AppState"
import { sameApproval } from "../ApprovalReference"
import { reconcileRunApprovals } from "./approval-reconciliation"
import type { ControllerContext } from "./context"
import type { GatewayWorkspaceBinding } from "./gateway"
import { runCardIdFor, runScopeFromCard } from "../RunReference"
import { gatewayBindingFor, resolveTargetRepo, type GatewayBinding } from "../RepoContext"
import { repositoryJobWorkspace } from "../RepositoryJobs"
import { refusalSentence } from "@smthrs/rpc/RefusalCopy"
import { FLOW_AUTHORING_ENTRY } from "@smthrs/rpc/FlowAuthoring"
import { ZERO_BALANCE_EXHAUSTED_TEXT } from "./failures"
import { Schema } from "effect"
import { declaredInput, formFieldsFor, draftFrom, missingFields } from "../../flows/FlowForms"
import type { FormsController } from "./forms"
import { flowArgs } from "../../flows/FlowArgs"
import { projectRuntimeCard, runtimeApprovalIdOf, runtimeApprovalKey } from "../RuntimeProjection"
import { knowledgeFlowAvailable } from "../KnowledgeFeatures"
import { createWorkflowLaunchController } from "./workflow-launch"
import { canonical, digest } from "@smthrs/core/Digest"
import { planCardGraph, planCardNode, planCardSnapshot } from "../../cards/PlanNodes"
import type { FlowDurationsReader } from "./flowDurations"
import { foldRunGraph, runGraphOf } from "../../cards/FlowGraphStatus"
import { rekeySummary, type PreviewNode, type RekeySummary } from "../../cards/flowGraph/Rekey"
import { runtimeRunKey } from "../RuntimeProjection"
import { isTriggerNodeId } from "../../cards/FlowGraphTriggerNode"
import { actorSharedState } from "../ActorBindings"
import { authoredSources } from "../FlowAuthoringReceipts"
import { createFlowAuthoringController } from "./flowAuthoring"

/**
 * A launch the workspace refused, in the wire's own words and shape: the
 * message the seam surfaces, and the typed error's code (or tag) when the
 * gateway named one, so a caller can answer a known refusal by shape rather
 * than by matching prose (ControlError.FlowNotFound carries no message at all).
 */
export interface LaunchRefusal {
  readonly message: string
  readonly code?: string
  readonly retryAfterSeconds?: number
}

export interface WorkflowController {
  readonly resumeWorkflowRequests: () => void
  readonly retryWorkflowRequest: (cardId: string) => boolean
  readonly createWorkflow: (description: string, repo?: string) => Promise<string | void | { readonly value: string }>
  readonly listWorkspaceWorkflows: ViewAction<[repo?: string, sourceCard?: string]>
  /** The Flows pane: the surface switch, and the same listing that fills it. */
  readonly showFlows: () => Promise<string | void | { readonly value: string }>
  readonly runWorkflow: (name: string, repo?: string, input?: Record<string, unknown>, sourceCard?: string) => Promise<string | void | { readonly value: string }>
  /** What a flow WOULD run: the plan card, filled in the background. */
  readonly planFlow: (name: string, repo?: string, input?: Record<string, unknown>, sourceCard?: string, against?: string) => Promise<string | void | { readonly value: string }>
  readonly chooseWorkflowRepo: (fullName: string) => Promise<string | void | { readonly value: string }>
  readonly forwardApprovalDecision: (
    card: Extract<Card, { kind: "approval" }>,
    decision: "approved" | "denied",
    answer?: unknown
  ) => Promise<void>
  /*
   * Lane runs shares the workflow lane's launch path: the run inbox's open,
   * resume, and rerun acts provision the same workspace, launch through the
   * same seam, and record the run on the same card, rather than growing a
   * second launch that could drift from the one `flow.run` proves.
   */
  readonly workflowIdentityGuard: () => string | undefined
  /** The refusal a $0 balance answers a launch with, already in the transcript; undefined when work may start. */
  readonly workflowBalanceGuard: () => string | undefined
  readonly workflowTargetRepo: (preferred?: string) => { readonly repo: string } | { readonly error: string }
  readonly provisionWorkspace: (repo: string, binding?: GatewayWorkspaceBinding, signal?: AbortSignal) => Promise<true | string>
  readonly upsertRunCard: (args: {
    readonly runId: string
    readonly repo: string
    readonly workflow: string
    readonly title: string
    readonly firstStep: string
    readonly workspaceId?: string
    readonly input?: Record<string, unknown>
    /** The run's kind (prototype, implement); absent for every other run. */
    readonly kind?: string
  }) => string
  readonly launchWorkflow: (args: {
    readonly repo: string
    readonly workflow: string
    readonly input: Record<string, unknown>
    readonly title: string
    readonly binding?: GatewayWorkspaceBinding
    readonly kind?: string
  }) => Promise<{ readonly runId: string } | LaunchRefusal>
  /** A decision made on the workspace approvals inbox, for a gate whose own card never landed. */
  readonly forwardInboxApprovalDecision: (
    cardId: string,
    requestId: string,
    decision: "approved" | "denied",
    runId?: string,
    answer?: unknown
  ) => Promise<void>
}

export const createWorkflowController = (
  ctx: ControllerContext,
  nextTranscriptOrdinal: () => number,
  pumpWorkflowRun: (cardId: string) => Promise<void>,
  renderFlowForm?: FormsController["renderFlowForm"],
  /* A plan card draws a graph, so the graph's predictions are read once, as
   * the card opens (controller/flowDurations.ts). */
  readFlowDurations?: FlowDurationsReader
): WorkflowController => {
  const { store, baseUrl, boundedFetch, gateway, unref, workflowPollMs, withToast } = ctx
  const RUN_POLL_MS = workflowPollMs
  const waitMs = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      unref(timer)
    })

  const workflowIdentityGuard = (): string | undefined => {
    const identity = store.collections.identitySessions.get("identity")
    if (identity?.state !== "signed-in") {
      return "Sign in with GitHub first: flows run on your own workspace."
    }
    if (!identity.allowlisted) {
      return "Flows open up with the closed alpha: your account isn't allowlisted yet."
    }
    return undefined
  }

  /*
   * Launch Checklist D-4 / AppState.ts:290-296's ruling: chat is
   * complimentary and a $0 balance never pauses it, but a workflow run is
   * non-complimentary work — the one place the pause discipline applies.
   * `allowedToStartWork` only ever reads false after a definitive
   * "ok"/"low"/"empty" balance answer (refreshBalanceImpl), so a down or
   * unread billing seam never blocks a launch. `billing === undefined` is
   * kept as an explicit defensive branch — `seed()` (AppStore.ts) always
   * inserts `initialBillingAccount()` before the store resolves, so in
   * practice the row always exists by the time a command can run; this
   * guards the invariant rather than a state the store can actually
   * produce. The refusal is dispatched into the transcript directly (not
   * left to the generic toast channel) so it lands as an embedded chat
   * message per THE EMBED LAW regardless of whether a button, slash
   * command, or the agent triggered the launch; `surfaceCommandFailure`
   * recognizes `ZERO_BALANCE_EXHAUSTED_TEXT` and skips its toast for
   * pointer-driven triggers, so a button click doesn't double-surface the
   * same refusal as both a transcript message and a toast.
   */
  const zeroBalanceGuard = (): string | undefined => {
    const billing = store.collections.billingAccounts.get("billing")
    if (billing === undefined || billing.allowedToStartWork) return undefined
    store.dispatch({ type: "message.appended", actor: "system", text: ZERO_BALANCE_EXHAUSTED_TEXT })
    return ZERO_BALANCE_EXHAUSTED_TEXT
  }

  /**
   * The loaded repositories are the universe (lane piper): an explicit
   * `owner/repo` names the target; otherwise one loaded repository is the
   * target, none is the honest "load one first", and several (wave 12 §2) is
   * the genuine question of WHICH loaded repository. One loaded repository is
   * not a question; more than one, with no argument, is. Callers that reject
   * ambiguity use the two-way `workflowTargetRepo` below.
   */
  const NO_REPO_LOADED =
    "No repository is loaded yet — sign in with /cloud.sign-in, or name one as owner/repo"

  const workflowTargetRepoOrAsk = (
    preferred: string | undefined
  ): { readonly repo: string } | { readonly error: string } | { readonly ask: ReadonlyArray<string> } => {
    if (preferred !== undefined || store.session().activeRepoKey != null) return resolveTargetRepo(store, preferred)
    const loaded = [...store.collections.repositories.values()].map((repository) => repository.id)
    if (loaded.length === 0) return { error: NO_REPO_LOADED }
    if (loaded.length > 1) return { ask: loaded }
    return { repo: loaded[0] ?? "" }
  }

  /** The two-way form, for the calls that do not ask (list, run-by-name). */
  const workflowTargetRepo = (preferred?: string): { readonly repo: string } | { readonly error: string } =>
    resolveTargetRepo(store, preferred)

  /** The `owner/repo` shape the seam addresses — the same one the Worker refuses past. */
  const isWorkflowRepoArg = (value: string): boolean =>
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(value)

  /**
   * `flow.create <description> [owner/repo]` — a trailing `owner/repo`
   * token is the target, everything before it is the description. Anything
   * that is not a repository name stays part of the description.
   */
  const splitDescriptionAndRepo = (
    input: string
  ): { readonly description: string; readonly repo?: string } => {
    const words = input.trim().split(/\s+/)
    const last = words.at(-1)
    if (words.length > 1 && last !== undefined && isWorkflowRepoArg(last)) {
      return { description: words.slice(0, -1).join(" "), repo: last }
    }
    return { description: input.trim() }
  }

  const provisionWorkspaceImpl = async (repo: string, binding: GatewayWorkspaceBinding, signal?: AbortSignal): Promise<true | LaunchRefusal> => {
    const login = store.collections.identitySessions.get("identity")?.login
    const epoch = ctx.accountEpoch
    const current = () => !ctx.disposed && ctx.accountEpoch === epoch &&
      store.collections.identitySessions.get("identity")?.state === "signed-in" && store.collections.identitySessions.get("identity")?.login === login
    // The Worker absorbs the upstream 409 and answers 200 `{ status: "provisioning" }`
    // while a workspace is mid-provision (apps/server/src/index.ts): poll that
    // body to a bounded deadline, never stampede. Any non-2xx here is a failure.
    const deadline = Date.now() + 180_000
    for (;;) {
      if (!current()) return { code: "request_superseded", message: "The account changed while the workspace was being prepared." }
      if (signal?.aborted) return { code: "request_aborted", message: "Workspace preparation was interrupted." }
      let body: { status?: unknown; message?: unknown } | undefined
      try {
        const response = await boundedFetch(`${baseUrl}${WORKFLOW_PROVISION_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo, ...binding }),
          signal
        })
        if (!response.ok) {
          const failure = await cloudFailure(response, "The workspace couldn't be prepared.")
          if (!current()) return { code: "request_superseded", message: "The account changed while the workspace was being prepared." }
          if (failure.refusal.rawCode === "plan_limit_exceeded") {
            return { code: "plan_limit_exceeded", message: await renderPlanLimit(store, failure.refusal, ctx.services.bootstrap?.capabilities.includes("billing.checkout") ?? true, ctx.commandActor) }
          }
          return { code: failure.code ?? "workspace_unavailable", message: refusalSentence(failure.refusal),
            ...(failure.retryAfterSeconds === null ? {} : { retryAfterSeconds: failure.retryAfterSeconds }) }
        }
        body = (await response.json().catch(() => undefined)) as typeof body
        if (!current()) return { code: "request_superseded", message: "The account changed while the workspace was being prepared." }
      } catch {
        return { code: "workspace_unreachable", message: "The workspace couldn't be prepared: the flow service didn't answer in time." }
      }
      if (body?.status === "ready") return true
      /*
       * Wave 12 §4 — the loaded set is a GITHUB set; a gateway needs a
       * Smithers Cloud repository. When they don't coincide the honest
       * answer is that fact, not the provision seam's raw HTTP failure.
       */
      if (body?.status === "no-cloud-repo") {
        return { code: "no_cloud_repo", message: `${repo} isn't on Smithers Cloud yet, so there's no workspace to run this on. Add it there and I'll pick it up, or point me at a repo that is.` }
      }
      if (body?.status === "provisioning") {
        if (signal !== undefined) return { code: "workspace_starting", message: "Your workspace is starting." }
        if (Date.now() > deadline) {
          return { code: "workspace_starting", message: `The workspace for ${repo} is still being prepared. Try again in a moment.` }
        }
        await waitMs(RUN_POLL_MS)
        continue
      }
      if (typeof body?.message === "string") return { code: "workspace_unavailable", message: body.message }
      return { code: "invalid_workspace_response", message: "The workspace couldn't be prepared." }
    }
  }

  const provisionWorkspace = (repo: string, requestedBinding?: GatewayWorkspaceBinding, signal?: AbortSignal): Promise<true | string> => {
    const binding = requestedBinding ?? gatewayBindingFor(store, repo)
    if ("error" in binding) return Promise.resolve(binding.error)
    return withToast(
      `flow.provision.${repo}.${binding.workspaceId ?? "legacy"}`,
      `Preparing your ${repo} workspace…`,
      "Workspace ready",
      async () => { const result = await provisionWorkspaceImpl(repo, binding, signal); return result === true ? true : result.message }
    )
  }

  const requests = createWorkflowLaunchController(ctx, nextTranscriptOrdinal, pumpWorkflowRun, provisionWorkspaceImpl)

  const authoring = actorSharedState(ctx, "flow-authoring", () => createFlowAuthoringController(ctx, nextTranscriptOrdinal, provisionWorkspace, pumpWorkflowRun))
  ctx.observeFlowAuthoring = authoring.observe
  ctx.resumeFlowAuthoring = authoring.resume

  const upsertRunCard = (args: {
    readonly runId: string
    readonly repo: string
    readonly workflow: string
    readonly title: string
    readonly firstStep: string
    readonly workspaceId?: string
    readonly input?: Record<string, unknown>
    readonly kind?: string
    /** The plan the launch was approved on; absent for a run this client did not start. */
    readonly plan?: NonNullable<Extract<Card, { kind: "run-trace" }>["payload"]["plan"]>
  }): string => {
    const cardId = runCardIdFor(store, args)
    const existing = store.collections.cards.get(cardId)
    const held = existing?.kind === "run-trace" ? existing.payload : undefined
    const card: Card = {
      id: cardId,
      kind: "run-trace",
      title: args.title,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? nextTranscriptOrdinal(),
      payload: {
        repo: args.repo,
        gatewayBindingVersion: 1,
        ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
        runId: args.runId,
        workflow: args.workflow,
        /* A monitor reopened after it settled keeps its recorded terminal status and failure. */
        phase: held?.phase ?? "running",
        steps: held?.steps ?? [args.firstStep],
        result: held?.result ?? null,
        lastSeq: held?.lastSeq ?? 0,
        ...(held?.error === undefined ? {} : { error: held.error }),
        ...(args.input === undefined ? held?.input === undefined ? {} : { input: held.input } : { input: args.input }),
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        /* The launch's own plan snapshot; a re-open keeps the one already held. */
        ...(args.plan === undefined ? held?.plan === undefined ? {} : { plan: held.plan } : { plan: args.plan }),
        /*
         * The reader's view of the trace (spec 06 §5) survives a re-open: a
         * card already in hand keeps its tab, filter, selection, cursor and
         * live-tail flag. A new card starts on live tail, following the
         * newest frame.
         */
        ...(held === undefined
          ? { liveTail: true }
          : {
            ...(held.facet === undefined ? {} : { facet: held.facet }),
            ...(held.filter === undefined ? {} : { filter: held.filter }),
            ...(held.traceView === undefined ? {} : { traceView: held.traceView }),
            ...(held.graph === undefined ? {} : { graph: held.graph }),
            ...(held.codingChangeId === undefined ? {} : { codingChangeId: held.codingChangeId }),
            ...(held.events === undefined ? {} : { events: held.events }),
            ...(held.selection === undefined ? {} : { selection: held.selection }),
            ...(held.cursorSeq === undefined ? {} : { cursorSeq: held.cursorSeq }),
            ...(held.liveTail === undefined ? {} : { liveTail: held.liveTail })
          })
      }
    }
    store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card })
    void pumpWorkflowRun(cardId)
    return cardId
  }

  /*
   * One card per (repo, flow, input), so a repeated ask moves the card it
   * already has.
   *
   * The input goes in as a digest of its RFC 8785 canonical bytes, not as its
   * JSON: the id reaches the DOM as an attribute and the toast as
   * `toast-flow.plan:<id>`, and `JSON.stringify` is key-order sensitive, so
   * the same input typed twice in another order would grow a second card.
   */
  const planCardId = (repo: string, name: string, input: Record<string, unknown>, against?: string): string =>
    `flow-plan-${repo}-${name}-${Object.keys(input).length === 0 ? "" : digest(canonical(input)).slice(0, 16)}${
      against === undefined ? "" : `-vs-${against}`}`

  /** The plan requests this controller has in flight, by card id. */
  const planning = new Set<string>()
  /** The newest ask per card, so an older answer that lands late writes nothing. */
  const planAttempts = new Map<string, number>()

  /*
   * A plan the reload outlived.
   *
   * Both maps above are this controller's memory, so a `pending` plan card
   * read back from storage has nothing behind it: no request is in flight,
   * nothing will ever settle it, and the body offers Run over a graph it
   * never drew. Planning is cheap and idempotent, but a silent re-issue would
   * also be a launch nobody asked for on this visit, so the card settles to
   * the failure it already is and keeps the Plan door that asks again.
   */
  for (const card of store.collections.cards.values()) {
    if (card.kind !== "flow-plan" || card.payload.status !== "pending") continue
    if (card.payload.sourceReceipt !== undefined) continue
    store.dispatch({
      type: "card.upsert",
      actor: "system",
      card: {
        ...card,
        status: "acted",
        payload: { ...card.payload, status: "failed", error: "The app restarted before this plan came back." }
      }
    })
  }

  /**
   * Fill one plan card from the workspace, in the background.
   *
   * A refusal stays on the card with the plan door beside it: the toast that
   * carried the progress is gone four seconds later, and a person who asked
   * for a graph and got nothing has to be able to see why and ask again.
   */
  /**
   * The re-key preview: a fresh plan against the plan a run was approved on.
   *
   * Every number comes off evidence this session already holds — that run's
   * plan snapshot, its journal, and the flow's measured history — so the
   * preview costs one `Plan` call and nothing else. It answers nothing when
   * the run it names is not one this client launched: without the plan that
   * run was approved on there is no previous key to compare against, and a
   * comparison with a plan taken now would say every node is unchanged.
   */
  const previewRekey = (
    repo: string,
    flowId: string,
    against: string,
    nextNodes: ReadonlyArray<PreviewNode>
  ): RekeySummary | undefined => {
    const card = [...store.collections.cards.values()].find((candidate) =>
      candidate.kind === "run-trace" && candidate.payload.runId === against && candidate.payload.repo === repo)
    if (card?.kind !== "run-trace" || card.payload.plan === undefined) return undefined
    const events = store.committedRuntimeRun(runtimeRunKey({
      repo,
      runId: against,
      ...(card.payload.workspaceId === undefined ? {} : { workspaceId: card.payload.workspaceId })
    }))?.events ?? []
    const previousNodes = card.payload.plan.nodes
    const durations = [...store.collections.flowDurations.values()]
      .filter((row) => row.repo === repo && row.flowId === flowId)
    return rekeySummary({
      flowId,
      previousNodes,
      nextNodes,
      events,
      status: runGraphOf(foldRunGraph(events), { planNodeIds: previousNodes.map((node) => node.id), flow: card.payload.workflow })?.status
        ?? new Map(),
      durations
    })
  }

  const fillPlanCard = async (args: {
    readonly id: string
    readonly repo: string
    readonly binding: GatewayWorkspaceBinding
    readonly name: string
    readonly input: Record<string, unknown>
    readonly attempt: number
    /** The run this plan was asked to be compared against (the re-key preview). */
    readonly against?: string
    readonly previousPlan?: Extract<Card, { kind: "flow-plan" }>["payload"]["previousPlan"]
    readonly sourceReceipt?: Extract<Card, { kind: "flow-plan" }>["payload"]["sourceReceipt"]
  }): Promise<void> => {
    const settle = (patch: Extract<Card, { kind: "flow-plan" }>["payload"]): string | void => {
      // An answer to an older ask, or to a controller that has since closed,
      // writes nothing: the card belongs to whatever was asked last.
      if (ctx.disposed || planAttempts.get(args.id) !== args.attempt) return
      const card = store.collections.cards.get(args.id)
      if (card?.kind !== "flow-plan") return
      /*
       * The reader's open drawer is theirs, not the answer's, so a re-plan
       * keeps it while the graph still draws that node: a drawer pointed at a
       * node this plan no longer has would be open over nothing
       * (controller/graph.ts). A schedule is drawn beside the plan and is
       * never in `nodes`, so a re-plan cannot take it away.
       */
      const held = card.payload.view
      const drawn = (node: string): boolean =>
        isTriggerNodeId(node) || (patch.nodes ?? []).some((candidate) => candidate.id === node)
      const kept = held?.node !== undefined && drawn(held.node) ? held : undefined
      store.dispatch({
        type: "card.upsert",
        actor: ctx.commandActor,
        card: {
          ...card,
          status: patch.status === "failed" ? "error" : "active",
          payload: kept === undefined ? patch : { ...patch, view: kept }
        }
      })
      return patch.status === "failed" ? patch.error : undefined
    }
    try {
      await withToast(`flow.plan:${args.id}`, `Planning ${args.name}`, `Planned ${args.name}`, async () => {
        const provisioned = await provisionWorkspace(args.repo, args.binding)
        if (provisioned !== true) return settle(refusedPlan(args, provisioned)) ?? provisioned
        const planned = await gateway.plan(args.repo, args.name, args.input, args.binding)
        if (planned.status !== "ok") return settle(refusedPlan(args, planned.message)) ?? planned.message
        const nodes = planned.value.nodes.map(planCardNode)
        /*
         * A comparison reads the flow's measured history BEFORE it is
         * computed. The estimate is a number off that history, and a read
         * fired beside the preview would answer after the card had already
         * frozen, so the first ask of a session would ship counts with no
         * estimate while the gateway held every row. The reader swallows
         * every refusal (controller/flowDurations.ts), so a box that will not
         * serve the projection costs the preview its estimate and nothing
         * else.
         */
        if (args.against !== undefined) await readFlowDurations?.(args.repo, args.name, args.binding)
        /* The comparison is over evidence already on the card and in the
         * collections, so it happens here, with the fresh plan in hand. */
        const rekey = args.against === undefined ? undefined : previewRekey(args.repo, args.name, args.against, nodes)
        settle({
          repo: args.repo,
          flowId: args.name,
          status: "done",
          ...(args.binding.workspaceId === undefined ? {} : { workspaceId: args.binding.workspaceId }),
          ...(Object.keys(args.input).length === 0 ? {} : { input: args.input }),
          planId: planned.value.planId,
          digest: planned.value.digest,
          nodes,
          /*
           * The labelled edges, where each node was declared, and the
           * revision those sites were read at — the same reduction the
           * launch path writes onto a run (cards/PlanNodes.ts), so a plan
           * card and a run's plan snapshot carry one shape.
           */
          ...(planned.value.graph === undefined ? {} : { graph: planCardGraph(planned.value.graph) }),
          ...(args.against === undefined ? {} : { against: args.against }),
          ...(args.previousPlan === undefined ? {} : { previousPlan: args.previousPlan }),
          ...(args.sourceReceipt === undefined ? {} : { sourceReceipt: args.sourceReceipt }),
          ...(rekey === undefined ? {} : { rekey })
        })
        // The graph is drawn, so its predictions are worth reading: one
        // call, off the toast's path, whose refusal shows as no numbers. A
        // comparison has already read them, above.
        if (args.against === undefined) void readFlowDurations?.(args.repo, args.name, args.binding)
        // Not a string: `withToast` reads a string outcome as the honest
        // failure line, so a drawn graph that answered with one would resolve
        // its own toast as a failure. The card is the claim surface anyway.
        return true
      })
    } finally {
      planning.delete(args.id)
    }
  }

  /** The plan card's payload for a refusal, keeping whatever graph it already drew. */
  const refusedPlan = (
    args: { readonly id: string; readonly repo: string; readonly binding: GatewayWorkspaceBinding; readonly name: string; readonly input: Record<string, unknown> },
    message: string
  ): Extract<Card, { kind: "flow-plan" }>["payload"] => {
    const card = store.collections.cards.get(args.id)
    const held = card?.kind === "flow-plan" ? card.payload : undefined
    return {
      ...(held ?? { repo: args.repo, flowId: args.name }),
      repo: args.repo,
      flowId: args.name,
      status: "failed",
      error: message,
      ...(args.binding.workspaceId === undefined ? {} : { workspaceId: args.binding.workspaceId }),
      ...(Object.keys(args.input).length === 0 ? {} : { input: args.input })
    }
  }

  const launchWorkflow = async (args: {
    readonly repo: string
    readonly workflow: string
    readonly input: Record<string, unknown>
    readonly title: string
    readonly binding?: GatewayWorkspaceBinding
    readonly kind?: string
  }): Promise<{ readonly runId: string } | LaunchRefusal> => {
    if (!knowledgeFlowAvailable(args.workflow, ctx.services.features)) return { message: "This feature is not enabled.", code: "FEATURE_DISABLED" }
    const launch = await gateway.launch(args.repo, args.workflow, args.input, args.binding)
    if (launch.status !== "ok") return { message: launch.message, ...(launch.code === undefined ? {} : { code: launch.code }) }
    const { runId } = launch.value
    /*
     * The plan snapshot the graph view draws before the first event arrives.
     * It is written only where the flow builder is on (D-038: the engine
     * records the nodes whatever the app flag says, and a launch with the
     * flag off must persist exactly what it persisted before the lane), and
     * only when the workspace named the plan AND answered with nodes: a plan
     * with no nodes is a workspace that serves no graph, and an empty node
     * list on the card would read as a flow that does nothing.
     *
     * The labelled edges and declaration sites ride with it when that same
     * answer carried them. Dropping them here left the card with `dependsOn`
     * alone, which says WHICH nodes wait and never WHY, and the reader of a
     * just-launched run got an unlabelled graph the plan door had already
     * been told the reasons for.
     */
    const planned = planCardSnapshot(launch.value)
    upsertRunCard({
      runId,
      repo: args.repo,
      workflow: args.workflow,
      title: args.title,
      firstStep: `Started ${args.workflow} on ${args.repo} (run ${runId}).`,
      ...(launch.value.workspaceId === undefined ? {} : { workspaceId: launch.value.workspaceId }),
      input: args.input,
      ...(args.kind === undefined ? {} : { kind: args.kind }),
      ...(planned === undefined ? {} : { plan: planned })
    })
    return { runId }
  }

  /*
   * Wave 12 §2 — the which-repo question, embedded. It renders only when the
   * answer is genuinely the user's (more than one loaded repository, no
   * argument); one act answers it, and the create resumes with the repo they
   * named.
   */
  const WORKFLOW_REPO_CARD_ID = "workflow-repo"

  const askWhichRepo = (
    description: string,
    repos: ReadonlyArray<string>
  ): { readonly value: string } => {
    const existing = store.collections.cards.get(WORKFLOW_REPO_CARD_ID)
    store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: {
        id: WORKFLOW_REPO_CARD_ID,
        kind: "workflow-repo",
        title: "Which repository?",
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: nextTranscriptOrdinal(),
        payload: { intent: "create", description, repos: [...repos], chosen: null }
      }
    })
    /*
     * A QUESTION is not a failure. A bare string result marks the outcome
     * `failed`, and live on canary the transcript read "Smithers tried
     * /flow.create — failed: You have 3 repositories loaded…" beside the card
     * that had just asked them, correctly, which one. The command did exactly
     * what it should; the value carries the question to the model, and the
     * card carries it to the human (§2b — values never render raw).
     */
    return { value: `You have ${repos.length} repositories loaded. Choose the one this flow belongs to.` }
  }

  const chooseWorkflowRepo = async (fullName: string): Promise<string | void | { readonly value: string }> => {
    const card = store.collections.cards.get(WORKFLOW_REPO_CARD_ID)
    if (card === undefined || card.kind !== "workflow-repo") {
      return "There's no repository question open right now."
    }
    if (card.payload.chosen !== null) {
      // A question is answered once. Two clicks landing before the card's
      // state came back would otherwise launch the same workflow twice, on
      // a seam where a launch is real work on the user's workspace.
      return `That question is already answered — I'm creating it on ${card.payload.chosen}.`
    }
    if (!card.payload.repos.includes(fullName)) {
      return `${fullName} isn't one of the repositories in that question.`
    }
    store.dispatch({
      type: "card.updated",
      actor: "user",
      id: WORKFLOW_REPO_CARD_ID,
      patch: { payload: { ...card.payload, chosen: fullName }, status: "acted" }
    })
    return createWorkflow(card.payload.description, fullName)
  }

  /*
   * A refused authoring attempt, said where it stays.
   *
   * The string a flow returns reaches the person as the command-failure
   * toast, which states itself and dismisses after four seconds. On
   * production that made this door look inert: it provisioned, the workspace
   * refused its plan, and by the time anyone looked there was no line, no
   * toast and no card — a door that created nothing and said nothing. The
   * refusing party's own sentence goes to the transcript, which is the half
   * of the answer that is still there afterwards.
   */
  const refuseCreate = (message: string): string => {
    store.dispatch({ type: "message.appended", actor: "system", text: message })
    return message
  }

  /**
   * The box a flow is authored on: whatever the person selected, and otherwise
   * the one this repository's reviewed jobs already run on, as the register
   * door reads it (`TriggersSeam.jobWorkspace`). A relay call that names no
   * workspace reaches the repository's product host, which carries neither the
   * authoring pack nor the registrar.
   */
  const flowAuthoringBinding = (repo: string): GatewayBinding => {
    const selected = gatewayBindingFor(store, repo)
    if ("error" in selected || selected.workspaceId !== undefined) return selected
    const jobs = repositoryJobWorkspace(
      store.collections.cards.values(),
      repo,
      store.collections.identitySessions.get("identity")?.login ?? null
    )
    return jobs === undefined ? selected : { workspaceId: jobs }
  }

  const createWorkflow = async (
    rawDescription: string,
    repoArg?: string
  ): Promise<string | void | { readonly value: string }> => {
    const guard = workflowIdentityGuard()
    if (guard !== undefined) return refuseCreate(guard)
    /* The zero-balance refusal is already an embedded message; a second one would say it twice. */
    const balanceGuard = zeroBalanceGuard()
    if (balanceGuard !== undefined) return balanceGuard
    // §2: `flow.create <description> [owner/repo]` — one argument string
    // for both the slash form and the agent tool.
    const split = repoArg === undefined
      ? splitDescriptionAndRepo(rawDescription)
      : { description: rawDescription.trim(), repo: repoArg }
    const description = split.description
    if (description === "") return refuseCreate("flow.create needs a description of what the flow should do")
    const target = workflowTargetRepoOrAsk(split.repo)
    if ("error" in target) return refuseCreate(target.error)
    if ("ask" in target) return askWhichRepo(description, target.ask)
    const repo = target.repo
    const binding = flowAuthoringBinding(repo)
    if ("error" in binding) return refuseCreate(binding.error)
    return authoring.request(description, repo, binding, ctx.commandActor)
  }

  /** A source card binds both catalog reads and launches to the retained host. */
  const workflowScope = (repoArg?: string, sourceCard?: string):
    { readonly repo: string; readonly binding: GatewayWorkspaceBinding } | { readonly error: string } => {
    if (sourceCard !== undefined) {
      const card = store.collections.cards.get(sourceCard)
      if (card?.kind !== "run-trace" && card?.kind !== "workflow-list" && card?.kind !== "flow-plan") return { error: "The source run or catalog card is unavailable." }
      if (repoArg !== undefined && repoArg !== card.payload.repo) return { error: "The source card belongs to another repository." }
      if (card.kind === "workflow-list" && card.payload.gatewayBindingVersion !== 1) {
        return { error: "This catalog has no recorded gateway. Refresh the flows from a source run first." }
      }
      return { repo: card.payload.repo, binding: card.payload.workspaceId === undefined ? {} : { workspaceId: card.payload.workspaceId } }
    }
    const target = workflowTargetRepo(repoArg)
    if ("error" in target) return target
    const binding = gatewayBindingFor(store, target.repo)
    return "error" in binding ? binding : { repo: target.repo, binding }
  }

  const listWorkspaceWorkflows = preparedView({ ...ctx, dispatch: store.dispatch, actor: () => ctx.commandActor, nextOrdinal: nextTranscriptOrdinal }, (repoArg?: string, sourceCard?: string) => {
    const guard = workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = workflowScope(repoArg, sourceCard)
    if ("error" in target) return target.error
    const { repo, binding } = target
    const id = binding.workspaceId === undefined ? `workflow-list-${repo}`
      : `workflow-list@${encodeURIComponent(repo)}@${encodeURIComponent(binding.workspaceId)}`
    return { id, title: `Flows: ${repo}`, before: () => provisionWorkspace(repo, binding), read: async () => {
    const list = await gateway.listFlows(repo, binding)
    if (list.status !== "ok") return list.message
    const workflows = list.value.filter(flow => knowledgeFlowAvailable(flow.flowId, ctx.services.features)).map((flow) => ({ key: flow.flowId, description: flow.description,
      ...(flow.inputSchema === undefined ? {} : { inputSchema: flow.inputSchema }) }))
    const existing = store.collections.cards.get(id)
    const card: Card = {
      id,
      kind: "workflow-list",
      title: `Flows: ${repo}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: nextTranscriptOrdinal(),
      payload: { repo, workflows, gatewayBindingVersion: 1,
        ...(binding.workspaceId === undefined ? {} : { workspaceId: binding.workspaceId }) }
    }
    return { card,
      value: workflows.length === 0
        ? `No flows on ${repo} yet.`
        : `Flows on ${repo}: ${workflows.map((workflow) => workflow.key).join(", ")}.`
    }
    } }
  })

  /*
   * Ask 5 (will, 2026-09-02): "where it says connect chat and world an option
   * should also be flows which should allow us to look at flows". The pane is
   * the flow.list card's rows, so opening it IS running that list — one seam,
   * one honest refusal when a repository is not loaded or the session is not
   * signed in, and the same toggle-back the World and Connect surfaces have.
   *
   * User-only on purpose: the model already has flow.list, whose answer is an
   * embedded card. THE EMBED LAW makes the pane the human's act alone.
   */
  const showFlows = async (): Promise<string | void | { readonly value: string }> => {
    if (store.session().surface === "flows") {
      store.dispatch({ type: "surface.changed", actor: "user", surface: "chat" })
      return
    }
    store.dispatch({ type: "surface.changed", actor: "user", surface: "flows" })
    return listWorkspaceWorkflows()
  }

  const runWorkflow = async (name: string, repoArg?: string, inputArg?: Record<string, unknown>, sourceCard?: string): Promise<string | void | { readonly value: string }> => {
    if (!knowledgeFlowAvailable(name, ctx.services.features)) return "This feature is not enabled."
    const input = inputArg ?? {}
    const guard = workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = workflowScope(repoArg, sourceCard)
    if ("error" in target) return target.error
    const { repo, binding } = target
    // A selected cloud workspace executes with its own configured provider.
    // Its gateway enforces workspace access, capacity and provider setup;
    // the separate Smithers prepaid balance funds managed workflow launches.
    if (binding.workspaceId === undefined) {
      const balanceGuard = zeroBalanceGuard()
      if (balanceGuard !== undefined) return balanceGuard
    }
    const source = sourceCard === undefined ? undefined : store.collections.cards.get(sourceCard)
    const declaration = source?.kind === "workflow-list"
      ? source.payload.workflows.find(flow => flow.key === name)?.inputSchema
      : sourceCard === undefined ? store.collections.repositoryFlows.get(repo)?.flows.find(flow => flow.id === name)?.inputSchema : undefined
    const schema = declaredInput(declaration)
    const fields = schema === undefined ? [] : formFieldsFor(schema, undefined)
    if (schema !== undefined && ((inputArg === undefined && fields.length > 0) || !Schema.is(schema)(input))) {
      if (fields.length > 0 && renderFlowForm !== undefined) {
        const rendered = renderFlowForm({ name: "flow.run", input: schema, payloadField: "input",
          args: flowArgs("flow.run", { name, repo, input, sourceCard }),
          via: ctx.commandActor === "smithers" ? "agent" : "user",
          cardId: `form-flow-run-${sourceCard ?? repo}-${name}`, title: `${name} — ${repo}`,
          hints: { submitLabel: "Run flow" } })
        if (rendered !== undefined) return { value: `Prepared ${name}'s input form${missingFields(fields, draftFrom(fields, input)).length > 0 ? "; fill in the missing fields" : "; correct the inputs before running"}.` }
      }
      return `The inputs do not match ${name}'s declared schema.`
    }
    return requests.start({ repo, binding, workflow: name, input, actor: ctx.commandActor })
  }

  /**
   * Plan a flow: what it WOULD run, before anything runs.
   *
   * The command returns as soon as the card exists. Planning crosses the
   * relay to a workspace that may still be provisioning, and a chat that sat
   * behind it would be a chat that stops answering because somebody asked to
   * see a graph. The card is the claim surface; the toast carries the
   * progress; the answer fills the card when it lands.
   */
  const planFlow = async (name: string, repoArg?: string, inputArg?: Record<string, unknown>, sourceCard?: string, against?: string): Promise<string | void | { readonly value: string }> => {
    const guard = workflowIdentityGuard()
    if (guard !== undefined) return guard
    const target = workflowScope(repoArg, sourceCard)
    if ("error" in target) return target.error
    const { repo, binding } = target
    const input = inputArg ?? {}
    // One card per (repo, flow, input): asking twice for the same plan moves
    // the card rather than growing a second one, and a second ask while the
    // first is in flight is the same request, not a second durable Plan.
    /* A preview is its own card: it states numbers about one run, and a
     * plain re-plan of the same flow must not silently drop them. */
    const previousCard = against === undefined ? undefined : [...store.collections.cards.values()].find((card) =>
      card.kind === "flow-plan" && card.payload.repo === repo && card.payload.workspaceId === binding.workspaceId && card.payload.flowId === name && card.payload.planId === against)
    const prior = previousCard?.kind === "flow-plan" ? previousCard.payload : undefined
    const previousPlan = prior?.planId === undefined || prior.digest === undefined || prior.nodes === undefined ? undefined
      : { planId: prior.planId, digest: prior.digest, nodes: prior.nodes }
    const id = previousCard?.id ?? planCardId(repo, name, input, against)
    if (planning.has(id)) return { value: `plan-requested flow=${name} repo=${repo}` }
    const attempt = (planAttempts.get(id) ?? 0) + 1
    planAttempts.set(id, attempt)
    planning.add(id)
    const existing = store.collections.cards.get(id)
    const held = existing?.kind === "flow-plan" ? existing.payload : undefined
    const source = sourceCard === undefined ? undefined : store.collections.cards.get(sourceCard)
    const receipt = source?.kind === "run-trace" && source.payload.workflow === FLOW_AUTHORING_ENTRY
      ? authoredSources(store.committedRuntimeRun(runtimeRunKey(source.payload))?.events ?? []).filter(receipt => receipt.flowId === name).at(-1)
      : undefined
    const sourceReceipt = receipt === undefined || source === undefined ? held?.sourceReceipt : { runCardId: source.id, receipt: receipt.receipt }
    store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: {
        id,
        kind: "flow-plan",
        title: `${name} — ${repo}`,
        status: "active",
        createdAt: existing?.createdAt ?? Date.now(),
        ordinal: sourceReceipt !== undefined && source?.kind === "run-trace" ? Math.max(0, source.ordinal - 1) : existing?.ordinal ?? nextTranscriptOrdinal(),
        payload: {
          repo,
          flowId: name,
          status: "pending",
          ...(binding.workspaceId === undefined ? {} : { workspaceId: binding.workspaceId }),
          ...(Object.keys(input).length === 0 ? {} : { input }),
          // A re-plan keeps the graph it last drew, and the drawer the reader
          // has open on it, until a new one lands.
          ...(held?.nodes === undefined ? {} : { nodes: held.nodes }),
          ...(held?.graph === undefined ? {} : { graph: held.graph }),
          ...(held?.view === undefined ? {} : { view: held.view }),
          ...(against === undefined ? {} : { against }),
          ...(previousPlan === undefined ? held?.previousPlan === undefined ? {} : { previousPlan: held.previousPlan } : { previousPlan }),
          ...(sourceReceipt === undefined ? {} : { sourceReceipt })
        }
      }
    })
    void fillPlanCard({ id, repo, binding, name, input, attempt, previousPlan: previousPlan ?? held?.previousPlan, sourceReceipt, ...(against === undefined ? {} : { against }) })
    return { value: `plan-requested flow=${name} repo=${repo}` }
  }

  /**
   * Decide one gate.
   *
   * The payload the gateway published goes back unchanged, so the client never
   * reconstructs authority, and one call records the decision AND resumes the
   * run it unblocked. The card still freezes from the server's answer, never
   * from local optimism: a decision the workspace did not take is a decision
   * the human has to be able to take again.
   */
  const forwardApprovalDecision = async (
    card: Extract<Card, { kind: "approval" }>,
    decision: "approved" | "denied",
    humanAnswer?: unknown
  ): Promise<void> => {
    const trusted = store.approvalRequest(card.id)
    if (trusted?.kind !== "approval") return
    const { repo, approval } = trusted.payload
    if (repo === undefined || approval === undefined) {
      store.dispatch({
        type: "card.approval.decision.failed",
        actor: "system",
        id: card.id,
        message: "This approval is not linked to a run, so there is nothing to send the decision to."
      })
      return
    }
    const binding = trusted.payload.workspaceId !== undefined ? { workspaceId: trusted.payload.workspaceId }
      : trusted.payload.runId === undefined ? {} : { workspaceId: runScopeFromCard(store, trusted, trusted.payload.runId)?.workspaceId }
    const normalizedId = runtimeApprovalIdOf({ ...trusted, payload: { ...trusted.payload, ...binding } })
    const normalized = normalizedId === undefined ? undefined : store.collections.runtimeApprovals.get(normalizedId)
    if (normalized !== undefined) {
      if (!normalized.pending || normalized.submissionId === undefined || normalized.row.status !== "pending") return
      const submissionId = normalized.submissionId
      const answer = await gateway.submitApproval(repo, normalized.row.payload, decision === "approved" ? "approve" : "deny", binding, humanAnswer)
      if (ctx.disposed || store.collections.runtimeApprovals.get(normalized.id)?.submissionId !== submissionId) return
      if (answer.status !== "ok" || answer.value.decision._tag === "Terminal") {
        const observed = await gateway.approvals(repo, normalized.scope.runId, binding)
        if (ctx.disposed) return
        if (observed.status === "ok") await reconcileRunApprovals(store, normalized.scope, observed.value)
      }
      if (ctx.disposed || store.collections.runtimeApprovals.get(normalized.id)?.submissionId !== submissionId) return
      await store.dispatch({ type: "gateway.approval.submission.changed", actor: answer.status === "ok" && answer.value.decision._tag !== "Terminal" ? "user" : "system",
        submission: { id: normalized.id, submissionId, state: answer.status === "ok" && answer.value.decision._tag !== "Terminal" ? decision : "failed",
          ...(answer.status === "ok" && answer.value.decision._tag !== "Terminal" ? { decidedAt: Date.now() } : { error: answer.status === "error" ? answer.message : "This run has finished. The workspace has not confirmed a decision for this approval." }) }
      }).isPersisted.promise
      return
    }
    const submitted = await gateway.submitApproval(
      repo,
      approval as Parameters<typeof gateway.submitApproval>[1],
      decision === "approved" ? "approve" : "deny",
      binding,
      humanAnswer
    )
    if (submitted.status !== "ok" || submitted.value.decision._tag === "Terminal") {
      if (trusted.payload.runId !== undefined) {
        const observed = await gateway.approvals(repo, trusted.payload.runId, binding)
        if (observed.status === "ok") await reconcileRunApprovals(store, { repo, runId: trusted.payload.runId, ...binding }, observed.value)
      }
      const current = store.collections.cards.get(card.id)
      if (current?.kind === "approval" && current.payload.decision !== undefined) return
      store.dispatch({
        type: "card.approval.decision.failed",
        actor: "system",
        id: card.id,
        message: submitted.status === "error" ? submitted.message : "This run has finished. The workspace has not confirmed a decision for this approval."
      })
      return
    }
    store.dispatch({
      type: "card.approval.decided",
      actor: "user",
      id: card.id,
      decision,
      decidedAt: Date.now()
    })
  }
  /**
   * A decision made on the workspace approvals inbox (lane runs §5).
   *
   * The gate the decision names belongs to a run whose approval card may
   * never have landed in this transcript — the inbox is how the human reaches
   * it anyway. The row carries the submit-ready envelope the gateway
   * published, so the decision goes back with it unchanged; the card freezes
   * from the server's answer, never from local optimism, exactly as
   * `forwardApprovalDecision` does for a per-run approval card.
   */
  const forwardInboxApprovalDecision = async (
    cardId: string,
    requestId: string,
    decision: "approved" | "denied",
    runId?: string,
    humanAnswer?: unknown
  ): Promise<void> => {
    const raw = store.collections.cards.get(cardId)
    const card = raw === undefined ? undefined : projectRuntimeCard(raw, [...store.collections.runtimeRuns.values()], [...store.collections.runtimeApprovals.values()])
    if (card === undefined || card.kind !== "approvals-inbox") return
    const trusted = store.approvalRequest(cardId)
    if (trusted?.kind !== "approvals-inbox") return
    // Old action IDs omitted the run. They remain valid only when unambiguous.
    const matches = trusted.payload.approvals.filter((entry) => entry.requestId === requestId && (runId === undefined || entry.runId === runId))
    if (matches.length !== 1) return
    const row = matches[0]!
    const displayed = card.payload.approvals.find((entry) => sameApproval(entry, row))
    if (row === undefined || displayed === undefined || displayed.decision !== undefined || displayed.pending === true) return
    const scope = runScopeFromCard(store, trusted, row.runId)
    const digest = (row.approval.target as { digest?: unknown } | undefined)?.digest
    const normalized = scope === undefined || typeof digest !== "string" ? undefined : store.collections.runtimeApprovals.get(runtimeApprovalKey(scope, row.requestId, digest))
    if (normalized !== undefined) {
      if (normalized.row.status !== "pending" || normalized.pending) return
      const submissionId = crypto.randomUUID()
      await store.dispatch({ type: "gateway.approval.submission.changed", actor: "user", submission: { id: normalized.id, submissionId, state: "pending" } }).isPersisted.promise
      if (ctx.disposed || store.collections.runtimeApprovals.get(normalized.id)?.submissionId !== submissionId) return
      const binding = { workspaceId: normalized.scope.workspaceId }
      const answer = await gateway.submitApproval(normalized.scope.repo, normalized.row.payload, decision === "approved" ? "approve" : "deny", binding, humanAnswer)
      if (ctx.disposed || store.collections.runtimeApprovals.get(normalized.id)?.submissionId !== submissionId) return
      if (answer.status !== "ok" || answer.value.decision._tag === "Terminal") {
        const observed = await gateway.approvals(normalized.scope.repo, normalized.scope.runId, binding)
        if (ctx.disposed) return
        if (observed.status === "ok") await reconcileRunApprovals(store, normalized.scope, observed.value)
      }
      if (ctx.disposed || store.collections.runtimeApprovals.get(normalized.id)?.submissionId !== submissionId) return
      const applied = answer.status === "ok" && answer.value.decision._tag !== "Terminal"
      await store.dispatch({ type: "gateway.approval.submission.changed", actor: applied ? "user" : "system", submission: { id: normalized.id, submissionId,
        state: applied ? decision : "failed", ...(applied ? { decidedAt: Date.now() } : { error: answer.status === "error" ? answer.message : "This run has finished. The workspace has not confirmed a decision for this approval." }) } }).isPersisted.promise
      return
    }
    store.dispatch({
      type: "card.updated",
      actor: "user",
      id: cardId,
      patch: {
        payload: {
          ...card.payload,
          approvals: card.payload.approvals.map((entry) => sameApproval(entry, row) ? { ...entry, pending: true } : entry)
        }
      }
    })
    const binding = trusted.payload.workspaceId !== undefined ? { workspaceId: trusted.payload.workspaceId }
      : { workspaceId: runScopeFromCard(store, trusted, row.runId)?.workspaceId }
    const submitted = await gateway.submitApproval(
      trusted.payload.repo,
      row.approval as Parameters<typeof gateway.submitApproval>[1],
      decision === "approved" ? "approve" : "deny",
      binding,
      humanAnswer
    )
    if (submitted.status !== "ok" || submitted.value.decision._tag === "Terminal") {
      const observed = await gateway.approvals(trusted.payload.repo, row.runId, binding)
      if (observed.status === "ok") await reconcileRunApprovals(store, { repo: trusted.payload.repo, runId: row.runId, ...binding }, observed.value)
    }
    const latest = store.collections.cards.get(cardId)
    if (latest === undefined || latest.kind !== "approvals-inbox") return
    if (latest.payload.approvals.find((entry) => sameApproval(entry, row))?.decision !== undefined) return
    const applied = submitted.status === "ok" && submitted.value.decision._tag !== "Terminal"
    // The local receipt time; projection observations never invent server timestamps.
    const decidedAt = Date.now()
    const approvals = latest.payload.approvals.map((entry) =>
      sameApproval(entry, row)
        ? applied
          ? { ...entry, decision, decidedAt, decisionError: undefined, pending: undefined }
          : { ...entry, decisionError: submitted.status === "error" ? submitted.message : "This run has finished. The workspace has not confirmed a decision for this approval.", pending: undefined }
        : entry
    )
    store.dispatch({
      type: "card.updated",
      actor: applied ? "user" : "system",
      id: cardId,
      patch: {
        payload: { ...latest.payload, approvals },
        // The inbox is acted only when no row is still undecided.
        ...(approvals.every((entry) => entry.decision !== undefined) ? { status: "acted" as const } : {})
      }
    })
  }
  return {
    resumeWorkflowRequests: requests.resume,
    retryWorkflowRequest: requests.retry,
    createWorkflow,
    listWorkspaceWorkflows,
    showFlows,
    runWorkflow,
    planFlow,
    chooseWorkflowRepo,
    forwardApprovalDecision,
    workflowIdentityGuard,
    workflowBalanceGuard: zeroBalanceGuard,
    workflowTargetRepo,
    provisionWorkspace,
    upsertRunCard,
    launchWorkflow,
    forwardInboxApprovalDecision
  }
}
