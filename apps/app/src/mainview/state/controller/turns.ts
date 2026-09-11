import { AGENT_RUNTIME_CONTEXT_VERSION, composeAgentInstructions, renderAgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import type { AgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import type { AgentChatMessage, AgentTurnFrame, TurnRefusal } from "@smthrs/rpc/NativeAgent"
import { hasCapability } from "@smthrs/rpc/AppBootstrap"
import { agentVisibleCatalog } from "../../flows/agentTools"
import type { CommandOutcome } from "../../flows/Commands"
import { parseSubmit } from "../../flows/registry"
import { boundToolResult, boundTurnRequest } from "../AgentTurnPolicy"
import { CardPatchSchema, CardSchema, MAIN_TAB_ID } from "../AppState"
import type { Card } from "../AppState"
import { isRuntimeOwnedCard } from "../isRuntimeOwnedCard"
import { roleMenuEntries } from "../../AgentRoleMenu"
import { GUIDE_LAST_STEP, GUIDE_LESSONS } from "../../onboarding/lessons"
import { currentAgentRoles } from "./agents"
import type { ImpossibleAskClass, InstructionRole, InstructionStage } from "../Instructions"
import { CHAT_INSTRUCTIONS_CAP_BYTES, INSTRUCTIONS_HEADROOM_BYTES, bytesOf, smithersInstructions } from "../Instructions"
import {
  impossibleAskOf,
  renderedAskTurnText,
  renderedRunTurnText,
  RUN_LAUNCH_COMMANDS,
  runLaunchCommandOf,
  toolResultLaunchedRun
} from "../RunClaims"
import { activeCatalogRepositoryId, activeRepositoryId } from "../RepoContext"
import { WORLD_BODY_BUDGET, worldContextDocuments } from "../WorldContext"
import { downloadUrlOf } from "./app"
import type { ActiveTurn, ControllerContext, PendingToolCall } from "./context"

/**
 * The client-side tool-loop leg cap, mirroring the chat worker's
 * CHAT_MAX_TOOL_LEGS default (8): over it the turn ends honestly instead of
 * looping forever on a model that keeps calling tools.
 */
const MAX_TOOL_LEGS = 8
/**
 * The chain's own doors (DESIGN.md §14): calls that ARE the surface — the
 * author seat and the transcript doors — rather than acts on the app, so
 * they never render an act row of their own.
 */
const CHAIN_SURFACE_CALLS = new Set(["author", "say", "card.show", "card.update"])

export interface TurnControllerDependencies {
  readonly settleTurnBilling: () => void
  /** The next transcript ordinal, so a refusal card lands at the end of the conversation. */
  readonly nextOrdinal: () => number
  readonly surfaceCommandFailure: (name: string, outcome: CommandOutcome) => void
  readonly forwardApprovalDecision: (
    card: Extract<Card, { kind: "approval" }>,
    decision: "approved" | "denied"
  ) => Promise<void>
  /** A decision clicked on the workspace approvals inbox (lane runs §5), addressed `inboxCardId:requestId`. */
  readonly forwardInboxApprovalDecision: (
    cardId: string,
    requestId: string,
    decision: "approved" | "denied"
  ) => Promise<void>
}

export interface TurnController {
  readonly subscribeToAgent: () => void
  readonly send: (text: string) => void
  readonly reset: () => void
  readonly stop: () => void
  readonly decideApproval: (id: string, decision: "approved" | "denied") => void
  readonly retryLastTurn: () => string | void
}

export const createTurnController = (
  ctx: ControllerContext,
  dependencies: TurnControllerDependencies
): TurnController => {
  const { store, repositories, agent } = ctx
  const { settleTurnBilling, nextOrdinal, surfaceCommandFailure, forwardApprovalDecision, forwardInboxApprovalDecision } =
    dependencies

  /*
   * The anonymous turn ceiling (apps/server turnLimit.ts; factory mock 22):
   * a signed-out visitor's refused turn is its own card, never the generic
   * failure line, because the way on is a door (sign in) and not a retry. The
   * branch is the refusal's CODE plus the session: a signed-out caller can
   * only be refused by the anonymous buckets, while a signed-in login that
   * trips its own ceiling has hit a bug and keeps the failure line the server
   * wrote for it. Only a session the app KNOWS is signed out takes the card:
   * "unknown" (the seam has not answered yet) and "unavailable" (the seam
   * failed) may belong to a signed-in login, and a Sign in door beside a
   * sentence about a login ceiling would contradict itself, so those keep the
   * failure line, whose server sentence carries its own sign-in instruction
   * for the anonymous wordings. The card carries the server's sentence and
   * reset time as sent; the reducer's completion settles the phase without a
   * bubble.
   */
  const refuseAnonymousTurn = (turnId: string, refusal: TurnRefusal): boolean => {
    if (refusal.code !== "turn_rate_limited") return false
    if (store.collections.identitySessions.get("identity")?.state !== "signed-out") return false
    const card: Card = {
      id: `anonymous-ceiling-${turnId}`,
      kind: "anonymous-ceiling",
      title: "Exploring is paused",
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: { message: refusal.message, retryAt: refusal.retryAt }
    }
    store.dispatch({ type: "card.upsert", actor: "system", card })
    store.dispatch({ type: "message.response.completed", actor: "smithers", turnId })
    return true
  }

  const handleCardFrame = (frame: Extract<AgentTurnFrame, { type: "card" | "card.update" }>): void => {
    if (frame.type === "card") {
      if (isRuntimeOwnedCard(frame.card) || isRuntimeOwnedCard(store.collections.cards.get(frame.card.id)) ||
        store.approvalRequest(frame.card.id) !== undefined) return
      store.dispatch({ type: "card.upsert", actor: "smithers", card: frame.card })
      return
    }
    const patch = CardPatchSchema.safeParse(frame.patch)
    const existing = store.collections.cards.get(frame.id)
    if (isRuntimeOwnedCard(existing) || store.approvalRequest(frame.id) !== undefined) return
    if (!patch.success || existing === undefined || patch.data.kind !== existing.kind) {
      console.warn("Smithers dropped a card.update frame for an unknown or invalid card", frame.id)
      return
    }
    const merged = CardSchema.safeParse({ ...existing, ...patch.data, id: existing.id,
      payload: patch.data.payload === undefined ? existing.payload :
        existing.kind === "repo-onboarding" ? patch.data.payload : { ...existing.payload, ...patch.data.payload }
    })
    if (!merged.success) {
      console.warn("Smithers dropped a card.update frame that fails schema", merged.error)
      return
    }
    store.dispatch({ type: "card.updated", actor: "smithers", id: frame.id, patch: merged.data })
  }

  /** The transcript as the chat contract reads it: no tool-act lines, no empty bubbles. */
  const contextMessages = (): ReadonlyArray<AgentChatMessage> =>
    store
      .agentContextSnapshot()
      .messages.filter((message) => message.act === undefined && message.text.trim() !== "")
      .map((message) => ({
        role: message.role === "user" ? ("user" as const) : ("assistant" as const),
        content: message.text
      }))
  ctx.contextMessages = contextMessages

  /*
   * The hidden runtime context, freshly derived from live collections on EVERY
   * turn leg (never cached): the server boundary renders it into the upstream
   * instructions, so the model truthfully knows it runs inside the Smithers
   * product. It is never dispatched, so it never enters the persisted visible
   * transcript; it carries no secrets (only state the client already holds).
   */
  /*
   * The Smithers Cloud session as the model must know it (agent-parity.md):
   * the native app holds a PAT session of its own (cloudSessions, mirrored
   * from the Bun side); on the web the GitHub sign-in IS the Cloud sign-in
   * (WEB_HOST_LINE), so the identity answers. A host with neither door is
   * unavailable, and a session the host has not answered yet is too.
   */
  const cloudContext = (): NonNullable<AgentRuntimeContext["cloud"]> => {
    const bootstrap = ctx.services.bootstrap
    if (bootstrap?.host === "cloud") {
      const identity = store.collections.identitySessions.get("identity")
      if (identity?.state === "signed-in") return { state: "signed-in", username: identity.login }
      return { state: identity?.state === "signed-out" ? "signed-out" : "unavailable", username: null }
    }
    if (bootstrap !== undefined && !hasCapability(bootstrap, "cloud.pat")) return { state: "unavailable", username: null }
    const session = store.collections.cloudSessions.get("cloud")
    switch (session?.state) {
      case "signed-in":
        return { state: session.scopes === "degraded" ? "degraded" : "signed-in", username: session.username }
      case "signed-out":
      case "signing-in":
        return { state: "signed-out", username: null }
      default:
        return { state: "unavailable", username: null }
    }
  }

  const agentRuntimeContext = (worldBodyBudget: number = WORLD_BODY_BUDGET): AgentRuntimeContext => {
    const snapshot = store.agentContextSnapshot()
    const current = store.session()
    const identity = store.collections.identitySessions.get("identity")
    const loadedRepoIds = [...store.collections.repositories.keys()]
    const billingAccount = store.collections.billingAccounts.get("billing")
    /*
     * Anonymous exploring (apps/server/PUBLIC-REPOSITORIES.md): signed out
     * with a public catalog repository selected, the visitor reads and asks
     * about it; anything that writes is one sign-in away.
     */
    const exploring = identity?.state === "signed-out" ? activeCatalogRepositoryId(store) : null
    const selected = current.selectedWorldDocumentId === null
      ? undefined
      : store.collections.worldDocuments.get(current.selectedWorldDocumentId)
    return {
      version: AGENT_RUNTIME_CONTEXT_VERSION,
      product: "smithers",
      capturedAt: snapshot.capturedAt,
      revision: snapshot.revision,
      surface: current.surface,
      theme: current.theme,
      selectedWorldDocument: selected?.path ?? null,
      /*
       * The guided introduction while it runs: the model sees the same
       * lesson transcript the user has, with the rule that chatter defers
       * to the lesson and real work skips it (onboarding.act finish).
       * Absent once the workspace step is reached — the tutorial is done.
       */
      ...(current.guide === undefined || current.guide.step >= GUIDE_LAST_STEP
        ? {}
        : {
          onboarding: {
            step: current.guide.step,
            stepCount: GUIDE_LESSONS.length,
            transcript: GUIDE_LESSONS.slice(0, current.guide.step + 1)
          }
        }),
      connectors: snapshot.connectors.map((connector) => ({
        kind: connector.kind,
        name: connector.name,
        status: connector.status,
        access: connector.access,
        root: connector.root,
        branch: connector.branch
      })),
      repositories: [...store.collections.repos.values()].map((repo) => ({
        id: repo.id,
        name: repo.name,
        path: repo.path,
        branch: repo.git?.branch ?? null,
        smithers: repo.smithers.detected
      })),
      /*
       * The selection `repo.select` (or the landing page's `?repo=` link)
       * made. Without it the model learned the choice only through
       * repo-scoped tool calls, never from a plain first message.
       */
      activeRepository: activeRepositoryId(store),
      activeRepositorySummary: store.collections.repositories.get(activeRepositoryId(store) ?? "")?.summary,
      /*
       * Sign-in IS the GitHub connector (§2a′): connection truth derives
       * from the validated session, never from the legacy local-connector
       * store. The repository inventory is the loaded repositories (lane
       * piper).
       */
      github: {
        connected: identity?.state === "signed-in",
        login: identity?.state === "signed-in" ? identity.login : null,
        repositories: identity?.state !== "signed-in" ? null : loadedRepoIds.length,
        /*
         * §22.7: a COUNT left the model declining to answer "what repos do
         * I have?" while the names were served plainly by the seam it
         * was already reading.
         */
        ...(identity?.state === "signed-in" && loadedRepoIds.length > 0
          ? { repositoryNames: loadedRepoIds }
          : {})
      },
      cloud: cloudContext(),
      /*
       * §22.7: the client holds the balance; the model did not, so asked
       * for it, it answered "$0.00" one line above a card its own tool call
       * had just rendered reading "$519 left".
       */
      billing: billingAccount === undefined
        ? null
        : {
          state: billingAccount.state,
          totalUsd: billingAccount.totalUsd,
          lifetimeChargedUsd: billingAccount.lifetimeChargedUsd,
          chargeCount: billingAccount.chargeCount
        },
      /*
       * §10.8: metadata alone made the World decorative — a note holding a
       * fact recorded nowhere else was invisible to the model, which said
       * it could not retrieve it. The notes' own words ride the turn under
       * a budget, open note first.
       */
      worldState: {
        documentCount: snapshot.worldState.documents.length,
        documents: worldContextDocuments(
          snapshot.worldState.documents,
          current.selectedWorldDocumentId,
          worldBodyBudget
        )
      },
      /*
       * Smithers is the first tab and knows every other one (docs/LOCAL-APP.md
       * "Tabs"): the model sees the strip as the human does, and reads a
       * tab's output with tab.read.
       */
      tabs: snapshot.tabs.map((tab) => {
        const harness = tab.kind === "harness"
          ? [...store.collections.harnesses.values()].find((candidate) => candidate.id === tab.harnessId)
          : undefined
        const account = harness?.account?.email ?? harness?.account?.label
        return {
          id: tab.id,
          kind: tab.kind,
          title: tab.title,
          ...(tab.kind === "harness" ? { harnessId: tab.harnessId } : {}),
          ...(account === undefined ? {} : { account }),
          ...((tab.kind === "terminal" || tab.kind === "harness") && tab.cwd !== undefined ? { cwd: tab.cwd } : {}),
          status: tab.kind === "terminal" || tab.kind === "harness"
            ? tab.exitCode === undefined ? ("running" as const) : ("exited" as const)
            : ("open" as const),
          ...(tab.kind === "terminal" || tab.kind === "harness" ? { exitCode: tab.exitCode ?? null } : {}),
          active: tab.id === (current.activeTabId ?? MAIN_TAB_ID)
        }
      }),
      capabilities: [
        "Hold a streaming conversation in this chat and read its visible transcript.",
        ...(snapshot.tabs.length > 1
          ? ["Read any other open tab's recent output (a terminal, a running agent, a card) with the tab.read <tabId> command — the tab ids are listed above."]
          : []),
        "Run app commands through the \"commands\" tool — the same code path as the UI buttons and slash commands.",
        "Render structured cards (plans, approvals, statuses, recommendations) in the transcript.",
        "Create, list, and run Smithers flows on the user's loaded repositories (flow.create, flow.list, flow.run). Runs report live as embedded cards in this chat.",
        ...(store.collections.repos.size > 0
          ? [
            "Read the open repositories listed above: files.list <path> [repo] lists a directory and files.read <path> [repo] renders a file as a card in this chat (a bare call means the active repository); target.list shows a repository's Smithers targets."
          ]
          : []),
        ...(exploring === null
          ? []
          : [
            `Read the public repository ${exploring} the visitor is exploring signed out: files.list <path> lists a directory and files.read <path> renders a file as a card in this chat, no sign-in needed.`
          ]),
        ...(repositories.available
          ? ["Connect a local repository the user picks in the native picker."]
          : [])
      ],
      limitations: [
        "Cannot see or control the host environment beyond what this context block states.",
        ...(exploring === null
          ? []
          : [
            `The visitor is signed out, exploring ${exploring}: anything that writes (pull requests, issues, workspaces, flow runs, secrets) needs GitHub sign-in, so when they ask for one execute auth.prompt instead.`
          ]),
        "Flow runs execute on the user's workspace gateway; any outbound act a run wants (pushes, PRs) pauses for the human's explicit approval. Never promise one landed without it.",
        repositories.available
          ? "Can only touch repositories the user explicitly connected, listed above."
          : "This pure-web client cannot connect local repositories (the native app can); none are connected unless listed above."
      ]
    }
  }

  /*
   * Wave 13 §F: the system prompt's capability section is GENERATED per turn
   * from the live command catalog and connector state — the one source of
   * truth — so the model's offers are bounded by what actually exists, and a
   * workflow is never presented as laundering an effect the catalog lacks.
   */
  const turnInstructions = (context?: AgentRuntimeContext, lastStage: InstructionStage = 3): string => {
    const identity = store.collections.identitySessions.get("identity")
    const signedIn = identity?.state === "signed-in"
    /*
     * The Bun side composes prompt + rendered context into ONE string the chat
     * seam caps at CHAT_INSTRUCTIONS_CAP_BYTES, so the prompt's budget is what
     * the cap leaves after this turn's context (world notes ride under their
     * own 8 000-char budget, tabs and repositories grow with the session).
     * The catalog degrades in stages to fit, down to `lastStage`; composeTurn
     * below owns the floor under that.
     */
    const contextBytes = context === undefined ? 0 : bytesOf(renderAgentRuntimeContext(context)) + 2
    const budgetBytes = CHAT_INSTRUCTIONS_CAP_BYTES - INSTRUCTIONS_HEADROOM_BYTES - contextBytes
    return smithersInstructions(agentVisibleCatalog(ctx.commands.callable()), {
      // The bootstrap is the one authority for the mode: the cloud Worker is the web app; anything else is native-shaped.
      host: ctx.services.bootstrap?.host === "cloud" ? "web" : "native",
      nativeDownloadable: downloadUrlOf(ctx.services) !== null,
      github: {
        connected: signedIn,
        login: signedIn ? identity.login : null,
        repositories: !signedIn ? null : store.collections.repositories.size
      },
      localRepositories: [
        ...new Set([
          ...[...store.collections.connectors.values()].map((connector) => connector.name),
          ...[...store.collections.repos.values()].map((repo) => repo.name)
        ])
      ],
      localRepositoriesAvailable: repositories.available
    }, instructionRoles(), { budgetBytes, lastStage })
  }

  /*
   * The floor under the budget. The catalog degrades first (stages 0→2 keep
   * every command's name); when the namespace list plus this turn's context
   * still exceeds the cap, the World bodies give way (each cut note says so
   * in the context, and the pane still holds it); only when even bodiless
   * notes do not fit does the catalog fall to stage 3 (namespaces and
   * counts, every name behind the list action). A turn fails on size only past that: a context
   * whose tabs and repositories alone pass the cap, which no session has
   * produced.
   */
  const composeTurn = (): { readonly context: AgentRuntimeContext; readonly instructions: string } => {
    const limit = CHAT_INSTRUCTIONS_CAP_BYTES - INSTRUCTIONS_HEADROOM_BYTES
    const render = (worldBodyBudget: number) => {
      const context = agentRuntimeContext(worldBodyBudget)
      const instructions = turnInstructions(context, 2)
      return { context, instructions, over: bytesOf(composeAgentInstructions(instructions, context)) - limit }
    }
    const whole = render(WORLD_BODY_BUDGET)
    if (whole.over <= 0) return { context: whole.context, instructions: whole.instructions }
    /*
     * The bodies give way to the largest budget that still fits, found by
     * bisection in a bounded number of renders. Cutting the budget by the
     * overshoot in one step landed on zero whenever the overshoot exceeded
     * the budget (a full catalog beside three notes at budget), which left
     * hundreds of bytes of room unused and every note bodiless.
     */
    let fit = render(0)
    if (fit.over > 0) return { context: fit.context, instructions: turnInstructions(fit.context, 3) }
    let low = 0
    let high = WORLD_BODY_BUDGET
    for (let round = 0; round < 8 && high - low > 16; round += 1) {
      const middle = Math.floor((low + high) / 2)
      const candidate = render(middle)
      if (candidate.over <= 0) {
        low = middle
        fit = candidate
      } else {
        high = middle
      }
    }
    return { context: fit.context, instructions: fit.instructions }
  }

  /*
   * The named roles the orchestrator may delegate to, with THIS host's
   * availability: only where local harnesses exist (agent.delegate registers
   * on local.harnesses), so a Cloud session is not told about tabs it lacks.
   */
  const instructionRoles = (): ReadonlyArray<InstructionRole> =>
    ctx.commands.find("agent.delegate") === undefined
      ? []
      : roleMenuEntries([...store.collections.harnesses.values()], currentAgentRoles(store)).map((entry) => ({
        id: entry.role.id,
        label: entry.role.label,
        purpose: entry.role.purpose,
        model: entry.role.model.label,
        available: entry.available,
        reason: entry.reason
      }))

  // Retries keep their transcript id, so its previous backend run must finish
  // cancelling before that id can launch again. The map also fences final
  // frames from the cancelled run while a retry holds the turn seat.
  const pendingCancellations = new Map<string, Promise<void>>()
  const cancelTurn = (turnId: string): void => {
    if (pendingCancellations.has(turnId)) return
    const pending = agent.cancelTurn(turnId)
    pendingCancellations.set(turnId, pending)
    const settled = () => { pendingCancellations.delete(turnId) }
    // Handle rejection even when no retry is waiting; a queued launch still
    // observes the original rejection through its ordinary failure handler.
    void pending.then(settled, settled)
  }

  const launchLeg = (
    turnId: string,
    messages: ReadonlyArray<AgentChatMessage>,
    /*
     * §4.13: the trailing messages a bound must not cut — the user's own
     * prompt, and the function_call/function_call_output pair of every tool
     * leg, which mean nothing split apart.
     */
    keepTail = 1
  ): void => {
    const turn = ctx.activeTurn
    if (turn === undefined || turn.id !== turnId) return
    /*
     * §4.13: the client re-sent the whole transcript every turn, so a long
     * conversation crossed the boundary's body limit and then stayed dead —
     * every later turn failed the same way, and /clear could not recover it
     * because /clear runs a model turn of its own into the same wall.
     */
    const { context, instructions } = composeTurn()
    const { request } = boundTurnRequest(
      {
        runId: turnId,
        messages,
        instructions,
        tools: ctx.commands.toolSpecs(),
        context
      },
      keepTail
    )
    const cancellation = pendingCancellations.get(turnId)
    const started = cancellation === undefined
      ? agent.startTurn(request)
      : cancellation.then(() => ctx.activeTurn === turn ? agent.startTurn(request) : undefined)
    void started
      .then((result) => {
        if (result?.status !== "error" || ctx.activeTurn !== turn) return
        ctx.activeTurn = undefined
        // §1: a leg that never started still ends a turn that launched a
        // run, and a claim streamed before the launch is already on screen.
        settleRunClaims(turn)
        if (result.refusal === undefined || !refuseAnonymousTurn(turnId, result.refusal)) {
          store.dispatch({
            type: "message.response.failed",
            actor: "system",
            turnId,
            message: result.message
          })
        }
        settleTurnBilling()
      })
      .catch(() => {
        if (ctx.activeTurn !== turn) return
        ctx.activeTurn = undefined
        settleRunClaims(turn)
        store.dispatch({
          type: "message.response.failed",
          actor: "system",
          turnId,
          message: "The native Smithers Cloud connection stopped responding."
        })
        settleTurnBilling()
      })
  }

  /*
   * The visible one-line record of a tool act (§2b transcript hygiene): at
   * most a compact Smithers-side line, actor smithers — the raw arguments or
   * result payload (the commands list's JSON, the browser read's text) NEVER
   * enters the conversation. The full-fidelity record lives in the toolCalls
   * collection for the admin dev-tools panel.
   */
  const toolActLine = (call: PendingToolCall, result: string): string => {
    let inner = call.name
    let action: string | undefined
    let args: string | undefined
    try {
      const parsed: unknown = JSON.parse(call.args)
      if (typeof parsed === "object" && parsed !== null) {
        // The model may spell the name "/browser" (the catalog's own
        // dialect, normalized at the agent boundary too) — stripped here
        // so the label renders /browser, never //browser.
        if ("name" in parsed && typeof parsed.name === "string") inner = parsed.name.replace(/^\/+/, "")
        if ("action" in parsed && typeof parsed.action === "string") action = parsed.action
        if ("args" in parsed && typeof parsed.args === "string") args = parsed.args
      }
    } catch {
      // The raw tool name is the honest label when the arguments don't parse.
    }
    if (call.name === "commands" && action === "list") return "Smithers checked what it can do here"
    if (result.startsWith("asked the user to confirm ")) return `Smithers asked for confirmation of /${inner}`
    if (result.startsWith("rendered a form for ")) return `Smithers opened the /${inner} form`
    if (
      call.name === "commands" && (inner === "browser" || inner === "browser.open") && !result.startsWith("failed:") && !result.startsWith("unknown-")
    ) {
      let host = args ?? ""
      try {
        host = new URL(args ?? "").host
      } catch {
        // Keep the raw args as the host label.
      }
      return `Smithers read ${host}`
    }
    /*
     * Wave 12 §1: the act line for a launch is deterministic too — it names
     * the run the client actually started, from the machine acknowledgment,
     * never from the model's wording.
     */
    const launched = runLaunchCommandOf(call.name, call.args)
    if (launched !== undefined && toolResultLaunchedRun(result)) {
      const workflow = /\bworkflow=(\S+)/.exec(result)?.[1] ?? inner
      const repo = /\brepo=(\S+)/.exec(result)?.[1]
      return `Smithers started a ${workflow} run${repo === undefined ? "" : ` on ${repo}`}`
    }
    const label = call.name === "commands" ? `/${inner}` : call.name
    if (result.startsWith("executed /") || (!result.startsWith("failed:") && !result.startsWith("unknown-"))) {
      return `Smithers ran ${label}`
    }
    // The honest failure, one line, payload-free: an error string that
    // still looks like raw JSON never reaches the transcript.
    const clean = result.trim().startsWith("{") || result.trim().startsWith("[") ? "that didn't work" : result
    return `Smithers tried ${label} — ${clean.replace(/\s+/g, " ").slice(0, 160)}`
  }

  /*
   * One tool-loop leg: execute the model's call through the registry (the
   * same path as buttons and slash, actor smithers), render the act line,
   * then POST the continuation turn with the tool-role result appended.
   */
  const continueToolLeg = async (turn: ActiveTurn): Promise<void> => {
    const call = turn.pendingCall
    if (call === undefined) return
    turn.pendingCall = undefined
    turn.toolLegs += 1
    // The registry selects fixed smithers bindings for the same flow
    // definitions used by buttons and slash commands.
    const result = await ctx.commands.executeForAgent({ name: call.name, arguments: call.args }).catch((error: unknown) =>
      `failed: ${error instanceof Error ? error.message : String(error)}`
    )
    if (ctx.activeTurn !== turn) return
    /*
     * Wave 12 §1: a real launch arms the deterministic claim surface for the
     * rest of this turn. A refusal or a chooser route launched nothing, so
     * there is no run for the model to misdescribe and its prose stands.
     */
    const launched = runLaunchCommandOf(call.name, call.args)
    if (launched !== undefined && toolResultLaunchedRun(result)) turn.runLaunch = launched
    store.dispatch({
      type: "toolcall.recorded",
      actor: "smithers",
      turnId: turn.id,
      name: call.name,
      arguments: call.args,
      result
    })
    store.dispatch({
      type: "message.tool.executed",
      actor: "smithers",
      turnId: turn.id,
      text: toolActLine(call, result)
    })
    /*
     * The record above keeps the whole result; the model gets it bounded, so
     * one wide tool output cannot fill the next request by itself and force
     * the turn bound to drop the conversation around it.
     */
    turn.toolItems.push(
      { type: "function_call", call_id: call.callId, name: call.name, arguments: call.args },
      { type: "function_call_output", call_id: call.callId, output: boundToolResult(result).modelOutput }
    )
    launchLeg(turn.id, [...contextMessages(), ...turn.toolItems], turn.toolItems.length + 1)
  }

  /*
   * Wave 12 §1 — the claim surface settles deterministically.
   *
   * A turn that launched a run renders the model's whole answer only when it
   * claims nothing about run state; otherwise the client's own line stands in
   * its place. The check reads the WHOLE answer (anything streamed before the
   * tool call plus everything withheld after it) because a preamble and a
   * continuation land in one bubble — half-suppressing a claim still ships it.
   */
  const settleRunClaims = (turn: ActiveTurn): void => {
    const command = turn.runLaunch
    const askClass = turn.askClass
    if (command === undefined && askClass === undefined) return
    const buffered = turn.claimBuffer
    turn.claimBuffer = ""
    turn.runLaunch = undefined
    turn.askClass = undefined
    const streamed = store.collections.messages.get(`message-${turn.id}-smithers`)?.text ?? ""
    const whole = `${streamed}${buffered}`
    if (whole.trim() === "") {
      /*
       * Nothing renderable was withheld, so nothing is substituted — but the
       * turn must still settle. `message.response.completed` no-ops when no
       * answer message exists, and the session's phase would have stayed
       * `responding` forever with the composer refusing every submit: held-
       * back whitespace bricked the chat. Report it as what it was, through
       * the empty-response path that already exists for exactly this.
       */
      turn.receivedText = false
      return
    }
    /*
     * Wave 13c: an ask-classed turn that launched nothing still answers
     * honestly — the class's deterministic line when the model offered the
     * impossible act, its own words otherwise (an unoffered answer flushes
     * verbatim through the same substitution that would have replaced it).
     */
    const text = command !== undefined
      ? renderedRunTurnText(command, whole)
      : renderedAskTurnText(askClass as ImpossibleAskClass, whole)
    store.dispatch({
      type: "message.claim.substituted",
      actor: "system",
      turnId: turn.id,
      text
    })
  }

  const subscribeToAgent = (): void => {
    const unsubscribe = agent.subscribe((frame: AgentTurnFrame) => {
      if (frame.runId !== ctx.activeTurn?.id || pendingCancellations.has(frame.runId)) return
      if (frame.type === "card" || frame.type === "card.update") {
        handleCardFrame(frame)
        return
      }
      if (frame.type === "tool_call") {
        // The model asked for a command; the done frame right after it ends
        // this leg, and the continuation is driven from there.
        ctx.activeTurn.pendingCall = { callId: frame.call_id, name: frame.name, args: frame.arguments }
        return
      }
      if (frame.type === "delta") {
        if (frame.text === "") return
        if (frame.kind === "text") {
          ctx.activeTurn.receivedText = true
          /*
           * Wave 12 §1: after a run launch the model's words are held until
           * the turn settles, so a claim is never rendered even for the beat
           * it would take to stream. Reasoning is unaffected — it is not the
           * answer, and the substitution replaces the answer.
           * Wave 13c: the same hold applies when the user's ask named an
           * impossible class — the offer is reviewed before it renders.
           */
          if (ctx.activeTurn.runLaunch !== undefined || ctx.activeTurn.askClass !== undefined) {
            ctx.activeTurn.claimBuffer += frame.text
            return
          }
        }
        store.dispatch({
          type: "message.response.delta",
          actor: "smithers",
          turnId: frame.runId,
          channel: frame.kind,
          delta: frame.text
        })
        return
      }
      /*
       * Chain frames (DESIGN.md §14). A settled command call renders the same
       * one-line act row the tool loop rendered — the harness's own doors
       * (author, say, cards, sys/*) are not user-facing acts. A gate
       * rejection is visible, payload-free, and in-character (§9: no
       * flow/run jargon) — never an error bubble, because the next link
       * corrects it. The remaining chain frames (link.*, steering.drained,
       * park, call.started) are journal evidence: debug mode renders them;
       * the transcript does not.
       */
      if (frame.type === "link.authored") {
        // A chain turn that ends without prose is still a worked turn: the
        // authored link is the proof, so the empty-response failure branch
        // below never applies to a chain turn.
        ctx.activeTurn.receivedText = true
        return
      }
      if (frame.type === "call.settled") {
        // Wave 12 parity: a settled launch call arms the deterministic claim
        // surface exactly as the tool loop did, so the model's prose about
        // the run substitutes at settle instead of rendering as a claim.
        if (RUN_LAUNCH_COMMANDS.includes(frame.name)) {
          ctx.activeTurn.runLaunch = frame.name
        }
        if (!CHAIN_SURFACE_CALLS.has(frame.name) && !frame.name.startsWith("sys/")) {
          store.dispatch({
            type: "message.tool.executed",
            actor: "smithers",
            turnId: frame.runId,
            text: `Smithers ran /${frame.name}`
          })
        }
        return
      }
      if (frame.type === "park") {
        // Approval parks explain themselves through the approval card; every
        // other park states the pause honestly instead of settling silently.
        if (frame.code !== "approval") {
          store.dispatch({
            type: "message.appended",
            actor: "system",
            text: frame.code === "quota"
              ? "Smithers paused — this turn ran out of budget."
              : "Smithers paused — it is waiting on something outside this chat."
          })
        }
        return
      }
      if (frame.type === "gate.rejected") {
        store.dispatch({
          type: "message.tool.executed",
          actor: "smithers",
          turnId: frame.runId,
          text: "Smithers adjusted its approach"
        })
        return
      }
      if (frame.type === "steering.drained") {
        store.dispatch({
          type: "message.tool.executed",
          actor: "smithers",
          turnId: frame.runId,
          text: "Smithers picked up your note"
        })
        return
      }
      if (frame.type !== "done") return
      const turn = ctx.activeTurn
      // A kill outranks a pending tool call: the terminal frame the Worker
      // injects for a server-side kill can land between the model's
      // `tool_call` frame and the upstream's own `done`. Continuing there
      // would run the tool and re-POST a continuation leg — the killed turn
      // would quietly carry on, which is exactly what B-3 forbids.
      if (
        frame.error === undefined &&
        frame.reason !== "cancelled" &&
        turn.pendingCall !== undefined
      ) {
        if (turn.toolLegs >= MAX_TOOL_LEGS) {
          ctx.activeTurn = undefined
          settleRunClaims(turn)
          store.dispatch({
            type: "message.response.failed",
            actor: "system",
            turnId: turn.id,
            message: `I hit the tool-call limit for this turn (${MAX_TOOL_LEGS}) — stopping here instead of looping.`
          })
          settleTurnBilling()
          return
        }
        void continueToolLeg(turn)
        return
      }
      ctx.activeTurn = undefined
      settleRunClaims(turn)
      if (frame.error !== undefined) {
        store.dispatch({
          type: "message.response.failed",
          actor: "system",
          turnId: turn.id,
          message: frame.error
        })
      } else if (frame.reason === "cancelled") {
        // A server-side kill ended the stream with the honest terminal frame —
        // render it interrupted (partial text kept), never a silent stop.
        store.dispatch({
          type: "message.response.cancelled",
          actor: "system",
          turnId: turn.id,
          detail: "That turn was stopped by the server."
        })
      } else if (frame.reason === "tool_limit") {
        // The server-side cap answered honestly; surface it the same way.
        store.dispatch({
          type: "message.response.failed",
          actor: "system",
          turnId: turn.id,
          message: "Smithers Cloud stopped this turn at its tool-call limit."
        })
      } else if (!turn.receivedText) {
        store.dispatch({
          type: "message.response.failed",
          actor: "system",
          turnId: turn.id,
          message: "Smithers Cloud returned an empty response."
        })
      } else {
        store.dispatch({
          type: "message.response.completed",
          actor: "smithers",
          turnId: turn.id
        })
      }
      settleTurnBilling()
    })
    // The subscription is scoped to the controller: disposing the controller
    // unsubscribes instead of leaking the listener for the page lifetime.
    if (typeof unsubscribe === "function") ctx.onDispose(unsubscribe)
  }

  /** A miss the registry did not render itself, stated as the refusal the toast channel carries. */
  const missAsFailure = (name: string, outcome: CommandOutcome): CommandOutcome =>
    outcome.status === "unknown-command"
      ? { status: "failed", error: `There is no /${name} flow. Type / to see everything Smithers can do.` }
      : outcome.status === "unavailable" && outcome.action === null
      ? { status: "failed", error: outcome.reason }
      : outcome

  const send = (text: string): void => {
    const parsed = parseSubmit(text, ctx.commands.all())
    if (parsed.kind === "empty") return
    if (parsed.kind === "unknown-command") {
      /*
       * §23.5: a name the app does not have used to go to the model as
       * prose, and the model reached for whatever flow it COULD see — so
       * `/reset` on a non-admin session ran `retry`. The app answers for
       * its own registry, through the one run path: a declared flow this
       * host lacks the door for is refused by its door (Commands.ts settle —
       * the download card when the native app is the answer, the sentence
       * otherwise), and only a name no host has is "no such flow".
       */
      store.dispatch({ type: "composer.changed", actor: "user", draft: "" })
      void ctx.commands.run(parsed.name).then((outcome) => surfaceCommandFailure(parsed.name, missAsFailure(parsed.name, outcome)))
      return
    }
    if (parsed.kind === "command") {
      /*
       * A bare /name is a command invocation, never a prompt for the agent.
       * The outcome is surfaced exactly as the pointer path surfaces it:
       * a flow the human typed and that refused must SAY so — dropping the
       * outcome here is what made `/name <args>` silent while bare `/name`
       * (which the slash menu routes through the pointer path) was honest.
       */
      store.dispatch({ type: "composer.changed", actor: "user", draft: "" })
      void ctx.commands
        .run(parsed.name, parsed.args)
        .then((outcome) => surfaceCommandFailure(parsed.name, outcome))
      return
    }
    const prompt = parsed.text
    if (store.session().phase !== "idle") {
      /*
       * Mid-turn input steers a steerable turn (DESIGN.md §14): the words
       * render as the user's own bubble now, and the running chain drains
       * them at its next link boundary. A backend without steering (the
       * proxy) keeps today's behavior — the input is not eaten, it stays
       * in the composer.
       */
      const turn = ctx.activeTurn
      if (turn !== undefined && agent.steer !== undefined) {
        // Wave 13c holds apply to steered asks too: an impossible ask
        // admitted mid-turn arms the same review the opening prompt gets.
        const steeredAsk = impossibleAskOf(prompt)
        if (steeredAsk !== undefined && turn.askClass === undefined) {
          turn.askClass = steeredAsk
        }
        void agent
          .steer(turn.id, prompt)
          .then((admitted) => {
            if (admitted) {
              store.dispatch({ type: "message.steered", actor: "user", turnId: turn.id, text: prompt })
            }
          })
          .catch(() => {
            // The draft remains untouched, so a rejected steer is retryable.
          })
      }
      return
    }
    /*
     * No auth gate: the local app chats anonymously through the local
     * origin (LOCAL-APP.md). Sign-in stays a command, never a precondition.
     */
    const turnId = crypto.randomUUID()
    ctx.activeTurn = {
      id: turnId,
      receivedText: false,
      toolLegs: 0,
      toolItems: [],
      pendingCall: undefined,
      runLaunch: undefined,
      // Wave 13c: the ASK arms the hold, detected from the user's words
      // before the model speaks — ordinary conversation arms nothing.
      askClass: impossibleAskOf(prompt),
      claimBuffer: ""
    }
    store.dispatch({ type: "message.submitted", actor: ctx.commandActor, turnId, text: prompt })
    launchLeg(turnId, contextMessages())
  }

  const reset = (): void => {
    const turn = ctx.activeTurn
    ctx.activeTurn = undefined
    if (turn !== undefined) cancelTurn(turn.id)
    ctx.stopWorkflowPumps()
    store.dispatch({ type: "conversation.reset", actor: "user" })
  }

  const stop = (): void => {
    if (ctx.activeTurn === undefined) return
    const turn = ctx.activeTurn
    const turnId = turn.id
    ctx.activeTurn = undefined
    cancelTurn(turnId)
    /*
     * §1: stopping does not un-launch the run, so the claim surface still
     * belongs to the client. Anything the model streamed before the tool call
     * is already rendered — settling here replaces it with the deterministic
     * line instead of leaving a half-turn's claim standing.
     */
    settleRunClaims(turn)
    store.dispatch({
      type: "message.response.cancelled",
      actor: "user",
      turnId,
      detail: "Stopped the current response."
    })
  }

  const decideApproval = (id: string, decision: "approved" | "denied"): void => {
    /*
     * An approvals-inbox row addresses its decision `inboxCardId:requestId`
     * (lane runs §5): the gate's own approval card may never have landed in
     * this transcript, so the row forwards through the inbox card, which
     * carries the submit-ready envelope the gateway published.
     */
    const separator = id.indexOf(":")
    if (separator > 0) {
      const inboxCardId = id.slice(0, separator)
      const requestId = id.slice(separator + 1)
      const inbox = store.collections.cards.get(inboxCardId)
      if (inbox?.kind === "approvals-inbox") {
        void forwardInboxApprovalDecision(inboxCardId, requestId, decision)
        return
      }
    }
    const displayed = store.collections.cards.get(id)
    const card = store.approvalRequest(id)
    if (card?.kind !== "approval" || displayed?.kind !== "approval" || displayed.status === "acted") return
    if (displayed.payload.pending === true || displayed.payload.decision !== undefined) return
    /*
     * A chain approval park (DESIGN.md §14): the decision resolves against
     * the runtime's pending ask, the card freezes, and the SAME lineage
     * resumes — approved converges under the grant, denied surfaces as an
     * observation the model routes around. Both decisions resume.
     */
    if (card.payload.chain === true && card.payload.runId !== undefined) {
      const lineage = card.payload.runId
      if (agent.resolveApproval === undefined) {
        store.dispatch({
          type: "card.approval.decision.failed",
          actor: "system",
          id,
          message: "This backend cannot resolve approvals."
        })
        return
      }
      /*
       * A turn-lineage decision needs the turn seat free before anything
       * is consumed: resolving first would burn the one-shot record and
       * freeze the card while resumeChainTurn no-ops, stranding the park.
       */
      if (
        card.payload.background !== true &&
        (store.session().phase !== "idle" || ctx.activeTurn !== undefined)
      ) {
        store.dispatch({
          type: "card.approval.decision.failed",
          actor: "system",
          id,
          message: "Finish or stop the current turn first, then decide this approval."
        })
        return
      }
      // The persisted card reconstructs the ask after a reload.
      const ask = card.payload.flow === undefined
        ? undefined
        : { name: card.payload.flow, claim: card.payload.capability }
      store.dispatch({ type: "card.approval.decision.pending", actor: "user", id })
      void agent.resolveApproval(lineage, decision, ask).then((resolved) => {
        if (!resolved) {
          store.dispatch({
            type: "card.approval.decision.failed",
            actor: "system",
            id,
            message: "That approval is no longer pending."
          })
          return
        }
        store.dispatch({
          type: "card.approval.decided",
          actor: "user",
          id,
          decision,
          decidedAt: Date.now()
        })
        // A background lineage resumed inside the runtime; only a turn
        // lineage re-enters the turn lifecycle here.
        if (card.payload.background !== true) resumeChainTurn(lineage)
      }).catch(() => {
        store.dispatch({
          type: "card.approval.decision.failed",
          actor: "system",
          id,
          message: "The decision could not reach the chain. Nothing was recorded — try again."
        })
      })
      return
    }
    const { runId, requestId, approval } = card.payload
    if (runId === undefined || requestId === undefined || approval === undefined) {
      // A card without a run identity has no backend to decide against —
      // say so honestly instead of fake-freezing it.
      store.dispatch({
        type: "card.approval.decision.failed",
        actor: "system",
        id,
        message: "This approval is not linked to a run, so there is nothing to send the decision to."
      })
      return
    }
    store.dispatch({ type: "card.approval.decision.pending", actor: "user", id })
    void forwardApprovalDecision(card, decision)
  }

  /*
   * Resume a parked chain lineage (DESIGN.md §14): same turn id, fresh
   * startTurn — the chain replays its settled prefix and re-asks the seam
   * under the recorded decision. The turn re-enters the ordinary frame
   * lifecycle, so rendering and settlement need no special path.
   */
  const resumeChainTurn = (lineage: string): void => {
    if (store.session().phase !== "idle" || ctx.activeTurn !== undefined) return
    ctx.activeTurn = {
      id: lineage,
      receivedText: true,
      toolLegs: 0,
      toolItems: [],
      pendingCall: undefined,
      runLaunch: undefined,
      askClass: undefined,
      claimBuffer: ""
    }
    const turn = ctx.activeTurn
    store.dispatch({ type: "chain.turn.resumed", actor: "system", turnId: lineage })
    void agent
      .startTurn({ runId: lineage, messages: contextMessages(), instructions: "" })
      .then((result) => {
        if (result.status === "error" && ctx.activeTurn === turn) {
          ctx.activeTurn = undefined
          store.dispatch({
            type: "message.response.failed",
            actor: "system",
            turnId: lineage,
            message: result.message
          })
        }
      })
      .catch(() => {
        if (ctx.activeTurn !== turn) return
        ctx.activeTurn = undefined
        store.dispatch({
          type: "message.response.failed",
          actor: "system",
          turnId: lineage,
          message: "The chain could not resume. Try the approval again."
        })
      })
  }

  /*
   * /retry re-RUNS the last turn — it does not re-SEND the prompt.
   *
   * `send` appends a user message, so retrying through it grew the transcript
   * a duplicate user/assistant pair per attempt and made every retry ship a
   * longer history than the one before it. The turn keeps its id: the answer
   * it produced is dropped and the same leg launches again over the context
   * that produced it.
   */
  /*
   * A refusal is returned as its reason so the run path can state it as a
   * toast: typed with nothing settled to re-run, `/retry` used to "execute"
   * and change nothing on screen, which reads as a dead command.
   */
  const retryLastTurn = (): string | void => {
    if (store.session().phase !== "idle" || ctx.activeTurn !== undefined) {
      return "A response is still in progress — stop it first, then retry."
    }
    const last = [...store.collections.messages.values()]
      .filter((message) => message.role === "user")
      .sort((left, right) => right.ordinal - left.ordinal)[0]
    const turnId = last?.id.match(/^message-(.+)-user$/)?.[1]
    if (turnId === undefined) return "Nothing to retry yet — send a message first."
    store.dispatch({ type: "message.retried", actor: "user", turnId })
    if (store.session().phase !== "responding") return
    ctx.activeTurn = {
      id: turnId,
      receivedText: false,
      toolLegs: 0,
      toolItems: [],
      pendingCall: undefined,
      runLaunch: undefined,
      askClass: impossibleAskOf(last?.text ?? ""),
      claimBuffer: ""
    }
    launchLeg(turnId, contextMessages())
  }

  return { subscribeToAgent, send, reset, stop, decideApproval, retryLastTurn }
}
