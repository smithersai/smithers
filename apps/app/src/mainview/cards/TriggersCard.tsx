/*
 * The dispatcher card (triggers.list; Factory design session 2026-09-07,
 * mock 2): the events a repository's rules wait for and the flows they
 * start, in words, for every visitor.
 *
 * Two sources, never mixed. The declared rows are the `on` table of
 * `.smithers/factory.json` read from the public mirror, each stating its
 * event in words and the flow it starts, under one pill naming where they
 * are declared. The live rows are the box's own registrations and exist
 * only when a signed-in session's box answered (`live`): the trigger store's
 * rows with their state (enabled, last fired, next fire, the run in flight)
 * and the webhook channels. Signed out there is no live column and no
 * placeholder for one. With nothing declared and no box answering, the card
 * is exactly one sentence. Register is the button door of triggers.register,
 * whose requirement makes sign-in the door.
 */
import { ruleFlows } from "@smthrs/rpc/FactoryProjection"
import { Button } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import { NO_RULES_SENTENCE } from "../state/seams/TriggersSeam"
import { timeLabel as clockLabel } from "../Timestamps"
import { describeEvent, describeSchedule } from "./TriggerEvents"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

type TriggerListCard = Extract<Card, { kind: "trigger-list" }>

export interface TriggerListCardActions {
  readonly onRunCommand: RunCommand
}

/** The live state of one registered trigger, in words: only what the box stated. */
export const triggerStateLabel = (trigger: TriggerListCard["payload"]["triggers"][number]): string => {
  const parts = [
    trigger.enabled ? "enabled" : "disabled",
    trigger.lastFiredAt === undefined ? "never fired" : `last fired ${clockLabel(trigger.lastFiredAt)}`
  ]
  if (trigger.nextFireAt !== undefined) parts.push(`next ${clockLabel(trigger.nextFireAt)}`)
  if (trigger.activeRunId !== undefined) parts.push(`running ${trigger.activeRunId}`)
  return parts.join(" · ")
}

export const TriggerListCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: TriggerListCard
} & TriggerListCardActions) => {
  const { repo, triggers } = card.payload
  const declared = card.payload.declared ?? []
  const live = card.payload.live === true
  const webhooks = live ? card.payload.webhooks ?? [] : []
  const liveRows = live ? triggers : []
  const empty = declared.length === 0 && liveRows.length === 0 && webhooks.length === 0
  return (
    <div className="world-card-list">
      {live ? <span className="world-card-path" data-testid="trigger-live">listening</span> : null}
      {empty ?
        <p className="smithers-card-note" data-testid="trigger-list-empty">{NO_RULES_SENTENCE}</p> :
        (
          <ul className="workflow-list" data-testid="trigger-list">
            {declared.length === 0 ? null : (
              <li className="workflow-list-row" data-testid="trigger-declared">
                <span className="world-card-path" data-testid="trigger-declared-pill">declared in .smithers/FACTORY.ts</span>
              </li>
            )}
            {declared.map((rule, index) => {
              const flows = ruleFlows(rule)
              return (
                <li key={`rule:${index}:${rule.event}`} className="workflow-list-row" data-rule={rule.event} data-source="declared">
                  <span className="workflow-list-text">
                    <strong>{describeEvent(rule.event)}</strong>
                    <span>
                      {rule.description === undefined ? `runs ${flows.join(", ")}` : `${rule.description} (${flows.join(", ")})`}
                    </span>
                  </span>
                </li>
              )
            })}
            {liveRows.map((trigger) => (
              <li key={trigger.id} className="workflow-list-row" data-trigger={trigger.id} data-enabled={trigger.enabled} data-source="box">
                <span className="workflow-list-text">
                  <strong>{describeSchedule(trigger.cron, trigger.timezone)}</strong>
                  <span>runs {trigger.flowId}</span>
                  <span data-testid={`trigger-state-${trigger.id}`}>{triggerStateLabel(trigger)}</span>
                </span>
              </li>
            ))}
            {webhooks.map((webhook) => (
              <li key={`webhook:${webhook.name}`} className="workflow-list-row" data-webhook={webhook.name} data-source="box">
                <span className="workflow-list-text">
                  <strong>Webhook {webhook.name}</strong>
                  {webhook.flowId === undefined ? null : <span>runs {webhook.flowId}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      <Button
        variant="ghost"
        size="sm"
        data-flow="triggers.register"
        data-testid="trigger-register"
        onClick={() => onRunCommand("triggers.register", repo)}
      >
        Register a rule
      </Button>
    </div>
  )
}

export const triggersCardFamily: CardFamily<"trigger-list"> = {
  "trigger-list": {
    render: (card, actions) => <TriggerListCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
