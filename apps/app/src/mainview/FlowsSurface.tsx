import { ViewSkeleton } from "./ViewSkeleton"
import { flowAction } from "./flows/FlowAction"
import { Button } from "@smthrs/ui"
import { Timer, Workflow } from "lucide-react"
import { useMemo } from "react"
import { TriggerListCardBody } from "./cards/TriggersCard"
import { WorkflowListCardBody } from "./cards/WorkflowCards"
import { useController } from "./ControllerContext"
import type { Card } from "./state/AppState"
import { SurfaceHeader } from "./SurfaceChrome"

type WorkflowListCard = Extract<Card, { kind: "workflow-list" }>
type TriggerListCard = Extract<Card, { kind: "trigger-list" }>

/*
 * The Flows pane beside the chat. Ask 5 (will, 2026-09-02): it shows what
 * `flow.list` last answered with — the newest listing card, rendered through
 * that card's own rows. NO INVENTION: with no listing yet the pane holds
 * nothing and the seam's refusal (why it could not list) stands in the chat
 * beside it. The dispatchers sit beside the flows: the newest triggers.list
 * card, rendered through its own rows. `cards` is the shell's card rows.
 */
export function FlowsSurface({ cards }: { readonly cards: ReadonlyArray<Card> }) {
  const controller = useController()
  const flowsCard = useMemo(
    () =>
      cards
        .filter((card): card is WorkflowListCard => card.kind === "workflow-list")
        .reduce<WorkflowListCard | undefined>(
          (latest, card) => (latest === undefined || card.ordinal > latest.ordinal ? card : latest),
          undefined
        ),
    [cards]
  )
  const triggersCard = useMemo(
    () =>
      cards
        .filter((card): card is TriggerListCard => card.kind === "trigger-list")
        .reduce<TriggerListCard | undefined>(
          (latest, card) => (latest === undefined || card.ordinal > latest.ordinal ? card : latest),
          undefined
        ),
    [cards]
  )
  const pending = cards.filter(card => card.kind === "status" && card.id.startsWith("workflow-list")).sort((a, b) => b.ordinal - a.ordinal)[0]
  const canListTriggers = controller.commands.find("triggers.list") !== undefined
  const runCommand = (name: string, commandArgs?: string) => controller.runCommand(name, commandArgs)

  return (
    <section data-keyboard-pane="Flows" className="flows-surface embedded-pane" aria-label="Flows on your workspace">
      <SurfaceHeader
        icon={<Workflow size={17} aria-hidden="true" />}
        title="Flows"
        subtitle={flowsCard?.payload.repo ?? ""}
        closeCommand="chat"
        onClose={() => controller.runCommand("chat")}
      >
        {/* The button door of triggers.list: the same registry entry the slash and the agent run. */}
        {canListTriggers ?
          (
            <Button
              variant="ghost"
              size="sm"
              data-testid="flows-triggers"
              {...flowAction(controller.runCommand, "triggers.list")}
            >
              <Timer size={14} aria-hidden="true" />
              Triggers
            </Button>
          ) :
          null}
      </SurfaceHeader>
      <div className="flows-content">
        {flowsCard !== undefined ? <WorkflowListCardBody card={flowsCard} onRunCommand={runCommand} /> : pending?.loading ? <ViewSkeleton /> : pending?.status === "error" ? <p>{pending.body}</p> : null}
        {triggersCard === undefined ? null : <TriggerListCardBody card={triggersCard} onRunCommand={runCommand} />}
      </div>
    </section>
  )
}
