/*
 * The trigger panel: what the box says about the schedules that fire this
 * flow (L6; D-031 for the node, D-043 for the schedule).
 *
 * It is a READ. No Control procedure enables, edits, deletes or test-fires a
 * trigger-store row — those verbs exist only in the CLI — so the panel offers
 * the two doors that do exist, `triggers.run` and `triggers.pause`, and only
 * for the rows they can address. Both are Plue routes keyed by slug, and the
 * trigger store's own rows carry no slug, so a box row is read-only here.
 *
 * Two registries feed one card and are never merged. A box TriggerStore row
 * carries the policies, the five upcoming occurrences, the scheduler's
 * heartbeat and the fire ledger. A Plue `repository-jobs` row carries a slug,
 * five-field UTC cron and its next fire, and nothing else — so it shows
 * nothing else, rather than a policy the registry never served.
 */
import { Button } from "@smthrs/ui"
import { flowAction } from "../flows/FlowAction"
import { flowArgs } from "../flows/FlowArgs"
import { timeLabel } from "../Timestamps"
import type { RunCommand } from "./CardFamily"
import { describeSchedule } from "./TriggerEvents"
import {
  fireTime,
  nextFireTimes,
  type TriggerCardRow,
  type TriggerFireRow,
  type TriggerFireTime,
  type TriggerGraphNode
} from "./FlowGraphTriggerNode"

/** What the ledger says one claimed occurrence became; `null` is the window between the claim and its result. */
const outcomeWord = (outcome: TriggerFireRow["outcome"]): string =>
  outcome === null ? "claimed, not yet reported" : outcome

/**
 * One instant, in the schedule's zone beside UTC when the two differ.
 *
 * The UTC reading says so. The zoned one does not repeat the zone it is in:
 * the schedule's own line above already states it, once.
 */
const Reading = ({ time }: { readonly time: TriggerFireTime }) => (
  <>
    {time.zoned === undefined ? null : <span className="flow-trigger-zoned">{time.zoned}</span>}
    <span className="flow-trigger-utc">{`${time.utc} UTC`}</span>
  </>
)

/** The policies this registration is registered under, as chips: only the ones the row carries. */
const policyChips = (row: TriggerCardRow): ReadonlyArray<readonly [string, string]> => [
  ...(row.overlap === undefined ? [] : [["overlap", `overlap ${row.overlap}`] as const]),
  ...(row.catchUp === undefined ? [] : [["catch-up", `catch-up ${row.catchUp}`] as const]),
  ...(row.maxCatchUp === undefined ? [] : [["max", `max ${row.maxCatchUp}`] as const])
]

/** One schedule, as the panel beside the graph shows it. */
const TriggerPane = ({
  trigger,
  repo,
  now,
  onRunCommand
}: {
  readonly trigger: TriggerGraphNode
  readonly repo: string
  readonly now: number
  readonly onRunCommand: RunCommand
}) => {
  const { row, state } = trigger
  const fires = nextFireTimes(row)
  /* A Plue registration is the one kind the run and pause routes address, and the one kind that serves no policies. */
  const slug = row.slug
  return (
    <li className="flow-trigger" data-trigger={row.id} data-trigger-state={state}>
      <div className="flow-trigger-head">
        <strong data-testid={`trigger-schedule-${row.id}`}>{describeSchedule(row.cron, row.timezone)}</strong>
        <span className="flow-trigger-word">{state}</span>
        {slug === undefined ? (
          <span
            className="flow-trigger-tick"
            data-testid={`trigger-tick-${row.id}`}
            data-live={row.schedulerLastTickAt !== undefined}
            aria-label={row.schedulerLastTickAt === undefined ? "no scheduler tick" : `scheduler ${timeLabel(row.schedulerLastTickAt, now)}`}
          />
        ) : null}
      </div>
      {row.pendingAt === undefined ? null : (
        <span className="flow-trigger-pending" data-testid={`trigger-pending-${row.id}`}>
          <Reading time={fireTime(row, row.pendingAt)} />
        </span>
      )}
      {row.activeRunId === undefined ? null : (
        <Button
          variant="ghost"
          size="sm"
          data-testid={`trigger-active-${row.id}`}
          {...flowAction(onRunCommand, "runs.open", flowArgs("runs.open", { runId: row.activeRunId, repo }))}
        >
          {row.activeRunId}
        </Button>
      )}
      {slug === undefined && policyChips(row).length > 0 ? (
        <span className="flow-trigger-policy" data-testid={`trigger-policy-${row.id}`}>
          {policyChips(row).map(([chip, label]) => (
            <span key={chip} className="flow-trigger-chip" data-chip={chip}>{label}</span>
          ))}
        </span>
      ) : null}
      {fires.length === 0 ? null : (
        <ol className="flow-trigger-fires" data-testid={`trigger-fires-${row.id}`}>
          {fires.map((time) => <li key={time.at}><Reading time={time} /></li>)}
        </ol>
      )}
      {row.fires === undefined ? null : (
        <ul className="flow-trigger-ledger" data-testid={`trigger-ledger-${row.id}`}>
          {row.fires.map((fire) => (
            <li key={`${fire.occurrenceAt}:${fire.runId ?? ""}`} data-outcome={fire.outcome ?? "claimed"}>
              <Reading time={fireTime(row, fire.occurrenceAt)} />
              <span className="flow-trigger-outcome">{outcomeWord(fire.outcome)}</span>
              {fire.waiting === undefined ? null : <span className="flow-trigger-chip" data-chip="waiting">{fire.waiting}</span>}
              {fire.runId === undefined ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  {...flowAction(onRunCommand, "runs.open", flowArgs("runs.open", { runId: fire.runId, repo }))}
                >
                  {fire.runId}
                </Button>
              )}
              {fire.error === undefined ? null : <span className="flow-trigger-error">{fire.error}</span>}
            </li>
          ))}
        </ul>
      )}
      {slug === undefined ? null : (
        <span className="flow-trigger-doors">
          <Button
            variant="ghost"
            size="sm"
            data-testid={`trigger-run-${slug}`}
            {...flowAction(onRunCommand, "triggers.run", flowArgs("triggers.run", { slug, repo }))}
          >
            Run now
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid={`trigger-${row.enabled ? "pause" : "resume"}-${slug}`}
            {...flowAction(onRunCommand, row.enabled ? "triggers.pause" : "triggers.resume",
                row.enabled ? flowArgs("triggers.pause", { slug, repo }) : flowArgs("triggers.resume", { slug, repo }))}
          >
            {row.enabled ? "Pause" : "Resume"}
          </Button>
        </span>
      )}
    </li>
  )
}

/**
 * The schedules that fire one flow, beside its graph.
 *
 * No schedule fires this flow means no panel: an empty region with a heading
 * over it would be a claim that something was read and found to be nothing,
 * which a plan card cannot make.
 */
export const FlowGraphTrigger = ({
  triggers,
  repo,
  onRunCommand,
  now = Date.now()
}: {
  readonly triggers: ReadonlyArray<TriggerGraphNode>
  readonly repo: string
  readonly onRunCommand: RunCommand
  readonly now?: number
}) => {
  if (triggers.length === 0) return null
  return (
    <ul className="flow-trigger-panel">
      {triggers.map((trigger) => (
        <TriggerPane key={trigger.id} trigger={trigger} repo={repo} now={now} onRunCommand={onRunCommand} />
      ))}
    </ul>
  )
}
