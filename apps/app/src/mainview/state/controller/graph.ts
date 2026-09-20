/*
 * The node drawer's reader state: which node of a graph a card has open, and
 * which of that node's tabs.
 *
 * A graph card draws a node per plan node; opening one is a drill-in, and a
 * drill-in is a fact about the card, not component state. The four flows here
 * write it, so a reload restores the drawer a person left open, the agent
 * reaches the same act, and nothing in the canvas owns a `useState` it would
 * lose on the next poll.
 *
 * Every select is validated against the nodes the card actually carries: the
 * plan's own for a plan card, and the plan's plus the JOURNAL's for a run,
 * because a run draws the graph the engine recorded and that graph can carry
 * nodes a plan snapshot never had (FlowGraphStatus.ts). An id neither answers
 * to is refused by name rather than opening a drawer over nothing.
 */
import { foldRunGraph, runGraphOf } from "../../cards/FlowGraphStatus"
import { triggerNodeId } from "../../cards/FlowGraphTriggerNode"
import type { CommandResult } from "../../flows/Flows"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"

type RunTraceCard = Extract<Card, { kind: "run-trace" }>
type FlowPlanCard = Extract<Card, { kind: "flow-plan" }>
type TriggerListCard = Extract<Card, { kind: "trigger-list" }>

/** Which of a selected node's tabs a graph card is showing. */
export type GraphDrawerTab = NonNullable<NonNullable<FlowPlanCard["payload"]["view"]>["tab"]>

/**
 * The tabs, in the order the drawer lays them out.
 *
 * The enum is the vocabulary a flow accepts; whether a tab RENDERS is the
 * drawer's own question, answered by the evidence the node carries (D-035).
 */
export const GRAPH_DRAWER_TABS = ["declaration", "code", "output", "events", "attempts"] as const satisfies ReadonlyArray<GraphDrawerTab>

/** Whether a word is one of the drawer's tabs. */
export const isGraphDrawerTab = (value: string): value is GraphDrawerTab =>
  (GRAPH_DRAWER_TABS as ReadonlyArray<string>).includes(value)

export interface GraphController {
  /** `runs.graph.select <runId> [nodeId]`: open a run graph node's drawer, or close it. */
  readonly selectGraphNode: (runId: string, nodeId?: string, sourceCard?: string) => Promise<CommandResult>
  /** `runs.graph.tab <runId> <tab>`: which tab of the open node the run's graph shows. */
  readonly graphNodeTab: (runId: string, tab: GraphDrawerTab, sourceCard?: string) => CommandResult
  /** `flow.plan.select <cardId> [nodeId]`: open a plan node's drawer, or close it. */
  readonly selectPlanNode: (cardId: string, nodeId?: string) => Promise<CommandResult>
  /** `flow.plan.tab <cardId> <tab>`: which tab of the open node the plan card shows. */
  readonly planNodeTab: (cardId: string, tab: GraphDrawerTab) => CommandResult
}

/** The tabs a refusal names, so the sentence and the enum cannot drift. */
const TAB_WORDS = GRAPH_DRAWER_TABS.join(", ")

export const createGraphController = (
  ctx: ControllerContext,
  /*
   * The app's one file read (seams/FilesSeam.ts). The Code tab renders the
   * declared file inline, and this is what puts it in hand: the same flow the
   * reader types, so the drawer holds no reader of its own and the card it
   * writes is the evidence both surfaces render.
   */
  readFile?: (
    path: string,
    repo?: string,
    anchor?: { readonly line: number; readonly column?: number },
    ref?: string
  ) => Promise<unknown>
): GraphController => {
  const { store } = ctx
  /** Writes, or clears, the refusal a Code tab is showing on whichever card it is. */
  const stateCodeError = (
    cardId: string,
    codeError: { readonly path: string; readonly message: string } | undefined
  ): void => {
    const card = store.collections.cards.get(cardId)
    if (card === undefined) return
    if (card.kind === "flow-plan") {
      const { codeError: _held, ...view } = card.payload.view ?? {}
      const next = codeError === undefined ? view : { ...view, codeError }
      /* `card.updated` MERGES, so a cleared refusal is a replacement, exactly as a closed drawer is. */
      store.dispatch({
        type: "card.upsert",
        actor: ctx.commandActor,
        card: { ...card, payload: { ...card.payload, view: next } }
      })
      return
    }
    if (card.kind !== "run-trace") return
    const { codeError: _held, ...graph } = card.payload.graph ?? {}
    const next = codeError === undefined ? graph : { ...graph, codeError }
    store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: { ...card, payload: { ...card.payload, graph: next } }
    })
  }

  /**
   * Reads the file one node was declared in, in the background.
   *
   * Opening the tab is the act; the read is the slow work behind it
   * (AGENTS.md §1), so the flow that opened the tab has already answered and
   * this runs under the shared toast. A refusal is a STRING, and it is
   * written onto the card as well as resolved into the toast, because a read
   * that settles inside the toast debounce never shows a toast at all.
   *
   * The read is AT the revision the site was recorded at (D-068). Without
   * one there is nothing to read that could be called the code that ran, so
   * nothing is read at all and the drawer shows no Code tab.
   */
  const readDeclaration = (
    cardId: string,
    repo: string,
    site: {
      readonly declaredAt?: { readonly path: string; readonly line: number } | undefined
      readonly sourceRevision?: string | undefined
    }
  ): void => {
    const { declaredAt, sourceRevision } = site
    if (readFile === undefined || declaredAt === undefined || sourceRevision === undefined) return
    /*
     * A file this conversation already holds AT THIS REVISION is already in
     * the drawer: the Code tab renders that card's payload. Re-reading it on
     * every tab switch would spend a request to redraw what is on screen. A
     * card of the same path read at another revision — or at none, which is
     * the working tree — is a different file and does not answer for this
     * one. A read that failed left no card, so the next open retries.
     */
    const held = [...store.collections.cards.values()].find((card) =>
      card.kind === "file" && card.payload.path === declaredAt.path &&
      card.payload.ref === sourceRevision &&
      (card.payload.repo === repo || card.payload.localRepoId === repo)
    )
    if (held !== undefined) {
      /*
       * The bytes are in hand; what this node asked for is its OWN line. So
       * the anchor moves onto the held card and the card goes to the tail,
       * which is the whole act — a door that did nothing here would not be
       * an act at all. A card already on that line is already the answer,
       * so nothing is dispatched and nothing jumps.
       */
      if (held.kind !== "file" || held.payload.line === declaredAt.line) return
      /* The anchor is a line and, when one was asked for, a column; a move to a line has none. */
      const { column: _column, ...payload } = held.payload
      store.dispatch({
        type: "card.upsert",
        actor: ctx.commandActor,
        card: { ...held, ordinal: store.nextOrdinal(), payload: { ...payload, line: declaredAt.line } }
      })
      return
    }
    void ctx.withToast(
      `files.read:${JSON.stringify([repo, declaredAt.path, sourceRevision])}`,
      `Reading ${declaredAt.path}`,
      `Read ${declaredAt.path}`,
      async () => {
        const answer = await readFile(declaredAt.path, repo, { line: declaredAt.line }, sourceRevision)
        /*
         * A refusal is a sentence, and the card is where a reader sees it:
         * work that settles inside the toast debounce never shows a toast at
         * all, so a refusal that only resolved one would be silent. The
         * drawer draws it with the door that asks again.
         */
        const message = typeof answer === "string" ? answer : undefined
        stateCodeError(cardId, message === undefined ? undefined : { path: declaredAt.path, message })
        return message ?? true
      }
    ).catch(() => {
      /* `withToast` already stated it; a rejected background read is not a second failure. */
    })
  }

  /*
   * The run's own card. A `sourceCard` names the card the act was raised
   * from, so it must be that run's card and not another's; without one the
   * lowest-id card recording this run is the card, exactly as every other
   * run reference resolves it (RunReference.ts runCardInScope).
   */
  const runCardFor = (runId: string, sourceCard?: string): RunTraceCard | undefined => {
    if (sourceCard !== undefined) {
      const source = store.collections.cards.get(sourceCard)
      return source?.kind === "run-trace" && source.payload.runId === runId ? source : undefined
    }
    return [...store.collections.cards.values()]
      .flatMap((card) => (card.kind === "run-trace" && card.payload.runId === runId ? [card] : []))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))[0]
  }

  /** Every node id this run's graph can draw: the plan's own, and the journal's. */
  const runNodeIds = (card: RunTraceCard): ReadonlySet<string> => {
    const ids = new Set((card.payload.plan?.nodes ?? []).map((node) => node.id))
    const recorded = runGraphOf(foldRunGraph(card.payload.events), {
      ...(ids.size === 0 ? {} : { planNodeIds: [...ids] }),
      flow: card.payload.workflow
    })
    for (const node of recorded?.nodes ?? []) ids.add(node.id)
    return ids
  }

  /**
   * Every node id this plan's canvas can draw.
   *
   * The schedules that fire the flow are drawn beside the plan and are
   * selectable like any other node, so their canvas ids belong here — but
   * only from a listing whose box actually answered (`live`), which is the
   * same evidence the card itself draws them from.
   */
  const planNodeIds = (card: FlowPlanCard): ReadonlySet<string> => {
    const ids = new Set((card.payload.nodes ?? []).map((node) => node.id))
    for (const listing of store.collections.cards.values()) {
      if (listing.kind !== "trigger-list") continue
      const catalog: TriggerListCard = listing
      if (catalog.payload.live !== true || catalog.payload.repo !== card.payload.repo) continue
      for (const row of catalog.payload.triggers) {
        if (row.flowId === card.payload.flowId) ids.add(triggerNodeId(row.id))
      }
    }
    return ids
  }

  const selectGraphNode = async (runId: string, nodeId?: string, sourceCard?: string): Promise<CommandResult> => {
    const card = runCardFor(runId, sourceCard)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the graph lives on its card.`
    if (nodeId !== undefined && !runNodeIds(card).has(nodeId)) return `Run ${runId} has no graph node ${nodeId}.`
    /*
     * `card.updated` MERGES a payload and an undefined value disappears in
     * the JSON journal, so closing the drawer replaces the card: a merge
     * would leave the node standing and a reload would open it again. The
     * camera is a different reader gesture and survives untouched.
     */
    const { node: _node, tab: _tab, ...rest } = card.payload.graph ?? {}
    const graph = nodeId === undefined ? rest : { ...rest, node: nodeId, ...(_tab === undefined ? {} : { tab: _tab }) }
    const { graph: _graph, ...payload } = card.payload
    await store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: { ...card, payload: Object.keys(graph).length === 0 ? payload : { ...payload, graph } }
    }).isPersisted.promise
    return { value: `graph-select run=${runId} node=${nodeId ?? "none"}` }
  }

  const graphNodeTab = (runId: string, tab: GraphDrawerTab, sourceCard?: string): CommandResult => {
    const card = runCardFor(runId, sourceCard)
    if (card === undefined) return `Open the run first (runs.open ${runId}): the graph lives on its card.`
    const graph = card.payload.graph
    if (graph?.node === undefined) return `Select a node on run ${runId} before choosing one of its tabs.`
    store.dispatch({
      type: "card.updated",
      actor: ctx.commandActor,
      id: card.id,
      patch: { payload: { ...card.payload, graph: { ...graph, tab } } }
    })
    /* The Code tab is a viewer, so opening it reads what it shows. */
    if (tab === "code") readDeclaration(card.id, card.payload.repo, runSite(card, graph.node))
    return { value: `graph-tab run=${runId} tab=${tab}` }
  }

  /**
   * Where the plan says one of its nodes was declared, and the revision it
   * read that site out of (D-054, D-068).
   */
  const planSite = (card: FlowPlanCard, nodeId: string) => ({
    declaredAt: (card.payload.graph?.nodes ?? []).find((node) => node.id === nodeId)?.declaredAt,
    sourceRevision: card.payload.graph?.sourceRevision
  })

  /**
   * Where the JOURNAL says one recorded node was declared, and the revision
   * the writer read it at (D-037, D-047, D-068).
   *
   * The pairing is the point: a site and the revision it came from are one
   * answer, so they are read off ONE source — the recorded graph where there
   * is one, the plan snapshot the launch wrote otherwise, exactly as the
   * canvas picks its nodes (FlowRunGraph.graphOf).
   */
  const runSite = (card: RunTraceCard, nodeId: string) => {
    const ids = (card.payload.plan?.nodes ?? []).map((node) => node.id)
    const recorded = runGraphOf(foldRunGraph(card.payload.events), {
      ...(ids.length === 0 ? {} : { planNodeIds: ids }),
      flow: card.payload.workflow
    })
    if (recorded !== undefined && recorded.nodes.length > 0) {
      return {
        declaredAt: recorded.nodes.find((node) => node.id === nodeId)?.declaredAt,
        sourceRevision: recorded.sourceRevision
      }
    }
    return {
      declaredAt: (card.payload.plan?.graph?.nodes ?? []).find((node) => node.id === nodeId)?.declaredAt,
      sourceRevision: card.payload.plan?.graph?.sourceRevision
    }
  }

  const planCardFor = (cardId: string): FlowPlanCard | undefined => {
    const card = store.collections.cards.get(cardId)
    return card?.kind === "flow-plan" ? card : undefined
  }

  const selectPlanNode = async (cardId: string, nodeId?: string): Promise<CommandResult> => {
    const card = planCardFor(cardId)
    if (card === undefined) return "Open the plan first: the graph lives on its card."
    if (nodeId !== undefined && !planNodeIds(card).has(nodeId)) return `That plan has no node ${nodeId}.`
    const { node: _node, tab: held, ...rest } = card.payload.view ?? {}
    const view = nodeId === undefined ? rest : { ...rest, node: nodeId, ...(held === undefined ? {} : { tab: held }) }
    const { view: _view, ...payload } = card.payload
    await store.dispatch({
      type: "card.upsert",
      actor: ctx.commandActor,
      card: { ...card, payload: Object.keys(view).length === 0 ? payload : { ...payload, view } }
    }).isPersisted.promise
    return { value: `plan-select card=${cardId} node=${nodeId ?? "none"}` }
  }

  const planNodeTab = (cardId: string, tab: GraphDrawerTab): CommandResult => {
    const card = planCardFor(cardId)
    if (card === undefined) return "Open the plan first: the graph lives on its card."
    const view = card.payload.view
    if (view?.node === undefined) return "Select a node on that plan before choosing one of its tabs."
    store.dispatch({
      type: "card.updated",
      actor: ctx.commandActor,
      id: card.id,
      patch: { payload: { ...card.payload, view: { ...view, tab } } }
    })
    if (tab === "code") readDeclaration(card.id, card.payload.repo, planSite(card, view.node))
    return { value: `plan-tab card=${cardId} tab=${tab}` }
  }

  return { selectGraphNode, graphNodeTab, selectPlanNode, planNodeTab }
}

/** The refusal the slash boundary and the agent both read for an unknown tab word. */
export const unknownTabRefusal = (flow: string): string => `${flow} needs one of ${TAB_WORDS}`
