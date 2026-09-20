/*
 * What a flow would run, before it runs (`flow.plan`).
 *
 * The card is the graph, the number of nodes in it, the schedules that fire
 * it, and the door that runs the flow it planned. The graph itself loads
 * lazily, so a conversation that holds a plan card does not pull xyflow into
 * the main chunk until it is read.
 */
import { Button } from "@smthrs/ui"
import { Suspense } from "react"
import { FlowGraphSurface } from "../ViewModules"
import { flowAction } from "../flows/FlowAction"
import { flowArgs } from "../flows/FlowArgs"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { criticalPathEta, etaWords } from "./flowGraph/Durations"
import { planCardState } from "./flowGraph/PlanState"
import { durationWords } from "./RunTrace"
import type { FlowDurationsRow } from "../state/AppState"
import { FlowGraphTrigger } from "./FlowGraphTrigger"
import { triggerGraph } from "./FlowGraphTriggerNode"
import { ViewSkeleton } from "../ViewSkeleton"
import { rekey as compareKeys } from "./flowGraph/Rekey"

export type FlowPlanCardModel = Extract<Card, { kind: "flow-plan" }>

/** The dispatcher listings in the conversation, which is where this card reads its schedules from. */
export type TriggerCatalog = Extract<Card, { kind: "trigger-list" }>

/**
 * The live trigger rows this repository's dispatcher answered with.
 *
 * `live` is the listing's own statement that a box answered on that show, so
 * a listing without it holds rows persisted from an earlier session and is
 * not evidence of anything now — the dispatcher card draws it the same way.
 */
const liveRowsFor = (catalogs: ReadonlyArray<TriggerCatalog>, repo: string): ReadonlyArray<TriggerCatalog["payload"]["triggers"][number]> =>
  catalogs.flatMap((catalog) => (catalog.payload.live === true && catalog.payload.repo === repo ? catalog.payload.triggers : []))

export const FlowPlanCardBody = ({
  card,
  onRunCommand,
  flowBuilder = false,
  triggerCatalogs = [],
  flowDurations = [],
  fileCards = []
}: {
  readonly card: FlowPlanCardModel
  readonly onRunCommand: RunCommand
  /** The dispatcher listings already in the conversation; no second read of the box. */
  readonly triggerCatalogs?: ReadonlyArray<TriggerCatalog>
  /** Every measured row the session holds; this card reads its own flow's. */
  readonly flowDurations?: ReadonlyArray<FlowDurationsRow>
  /** The files already read into this conversation; the drawer's Code tab renders the declared one. */
  readonly fileCards?: ReadonlyArray<Extract<Card, { kind: "file" }>>
  /*
   * The plan door renders only where the flow builder does. The family is
   * registered whatever the flag says, so a card persisted under the flag
   * still renders with it off, where `flow.plan` is not in the registry: the
   * button would answer "unknown command", which is not a door.
   */
  readonly flowBuilder?: boolean
}) => {
  const { repo, flowId, input, nodes, graph, view, rekey } = card.payload
  const changes = !flowBuilder || card.payload.previousPlan === undefined || nodes === undefined ? undefined : compareKeys(card.payload.previousPlan.nodes, nodes)
  /*
   * Where this plan ended up, as one closed set (flowGraph/PlanState.ts).
   * Every ending the seam can write is a case there, so a card cannot grow a
   * fourth one that falls through to the success door.
   */
  const state = planCardState(card.payload)
  const args = { name: flowId, repo, ...(flowBuilder ? { sourceCard: card.id } : {}), ...(input === undefined ? {} : { input }) }
  /* A dispatcher listing whose box answered is what makes "no schedule" a reading rather than a silence. */
  const live = liveRowsFor(triggerCatalogs, repo)
  const triggers = triggerGraph(live, flowId, nodes ?? [])
  /*
   * This flow's own history, and the estimate over it. The estimate is the
   * longest path, and it is absent whenever one node that would run has never
   * been measured: a partial sum reads as an estimate and is short by
   * whatever the unmeasured nodes take (D-030).
   */
  const measured = flowDurations.filter((row) => row.repo === repo && row.flowId === flowId)
  const eta = nodes === undefined || nodes.length === 0 ? undefined : criticalPathEta(nodes, measured, flowId)
  /*
   * The drill-in exists only where the flow builder does (D-038, D-050):
   * with the flag off the canvas has no selection model, no drawer and no
   * act, and the card is the card it was.
   */
  const drill = flowBuilder
    ? {
      repo,
      previousNodes: card.payload.previousPlan?.nodes,
      /* The revision the plan's declaration sites were read at (D-068). */
      ...(graph?.sourceRevision === undefined ? {} : { sourceRevision: graph.sourceRevision }),
      doors: { select: "flow.plan.select", tab: "flow.plan.tab", target: card.id } as const,
      ...(view?.node === undefined ? {} : { selected: view.node }),
      ...(view?.tab === undefined ? {} : { tab: view.tab }),
      ...(view?.codeError === undefined ? {} : { codeError: view.codeError }),
      files: fileCards,
      onRunCommand
    }
    : undefined
  /*
   * A schedule is drawn on the canvas where the canvas exists, and its detail
   * is the drawer that node opens. The panel is what a card shows when the
   * canvas does not draw them at all: with the flow builder off, and for a
   * plan with no nodes to draw a canvas for.
   */
  const drawnOnCanvas = drill !== undefined && nodes !== undefined && nodes.length > 0
  const panel = drawnOnCanvas ? [] : triggers.nodes
  return (
    <div className="flow-plan-card">
      <div className="flow-plan-head">
        {nodes === undefined || nodes.length === 0 ? null : <span className="flow-plan-count">{nodes.length}</span>}
        {eta === undefined ? null : <span className="flow-plan-eta">{etaWords(eta)}</span>}
        {changes === undefined ? null : <span className="flow-plan-key-changes">{changes.added.length + changes.rekeyed.length} changed keys</span>}
        {/*
          * The re-key preview, in numbers. `was` is a measurement of the run
          * this plan was compared against. The estimate keeps unchanged
          * nodes' measured costs unless that run recorded them clean. A
          * clean count describes that run, never promised future reuse.
          */}
        {rekey === undefined ? null : (
          <span className="flow-plan-rekey">
            <span className="flow-plan-rerun">re-keyed {rekey.rerun} of {rekey.total}</span>
            {rekey.etaMs === undefined
              ? null
              : <span className="flow-plan-rekey-eta">{etaWords(rekey.etaMs)}</span>}
            {rekey.wasMs === undefined ? null : <span className="flow-plan-was">was {durationWords(rekey.wasMs)}</span>}
            {rekey.cleanSettlements === undefined ? null : <span className="flow-plan-clean">was {rekey.cleanSettlements} clean</span>}
          </span>
        )}
        {/*
          * A refusal is answerable or it is nothing: the door that asks again
          * stands beside it, and the door that runs what was planned does
          * not. With the flag off `flow.plan` is not in the registry, so
          * there is no door to offer and the card states the refusal alone.
          */}
        {state.kind === "refused"
          ? flowBuilder
            ? <Button size="sm" variant="outline" {...flowAction(onRunCommand, "flow.plan", flowArgs("flow.plan", args))}>Plan</Button>
            : null
          : <Button size="sm" variant="outline" {...flowAction(onRunCommand, "flow.run", flowArgs("flow.run", args))}>Run</Button>}
      </div>
      {state.kind !== "refused" || state.sentence === undefined
        ? null
        : <p className="flow-plan-error">{state.sentence}</p>}
      {nodes === undefined || nodes.length === 0 ? null : (
        <Suspense fallback={<ViewSkeleton />}>
          <FlowGraphSurface
            nodes={nodes}
            graph={graph}
            durations={measured}
            triggers={drill === undefined || live.length === 0 ? undefined : triggers}
            drill={drill}
          />
        </Suspense>
      )}
      <FlowGraphTrigger triggers={panel} repo={repo} onRunCommand={onRunCommand} />
    </div>
  )
}

export const flowPlanCardFamily: CardFamily<"flow-plan"> = {
  "flow-plan": {
    render: (card, actions) => (
      <FlowPlanCardBody
        card={card}
        onRunCommand={actions.onRunCommand}
        flowBuilder={actions.flowBuilder}
        triggerCatalogs={actions.triggerCatalogs}
        flowDurations={actions.flowDurations}
        fileCards={actions.fileCards}
      />
    ),
    pill: (card) => card.payload.status
  }
}
