import { Button, Textarea } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import {
  NEXT_STEP,
  STEER,
  STEER_DELIVERED,
  STEER_LABEL,
  STEER_NOT_DELIVERED,
  STEER_NOT_SENT,
  STEER_REFUSAL_WORDS,
  STEER_SENDING,
  STEER_SENT,
} from "../contract"
import { type PageStep, responseStep, type SteerState, steerOpen, steersOf } from "../page"
import type { RunsActions } from "../runs.vibe"
import type { Inspection, RunPage, RunView, SteerSending, SteerSent } from "../schema"
import { useRuns } from "./RunsContext"

// A TODO's run's messages to its agent, and the composer that sends one (ruling TODO-3, docs/features/runs.md#steering).
// Each message reads where it is: Sending (in the outbox), Sent (taken), Delivered (the agent read it at a turn boundary;
// Next step selects the agent's step after it, its response), Not delivered (the agent ended first) or Not sent (refused,
// with why). The composer shows while the agent works. Every message is text; nothing renders as markup.

const WORDS: Readonly<Record<SteerState, string>> = {
  sending: STEER_SENDING,
  sent: STEER_SENT,
  delivered: STEER_DELIVERED,
  not_delivered: STEER_NOT_DELIVERED,
  not_sent: STEER_NOT_SENT,
}

export function RunSteers({ page, view, steps }: { page: RunPage; view: RunView; steps: ReadonlyArray<PageStep> }) {
  const { queries, actions } = useRuns()
  const { data: sending } = useLiveQuery(queries.steerSending)
  const { data: sent } = useLiveQuery(queries.steerSent)
  const items = steersOf(page, (sending ?? []) as ReadonlyArray<SteerSending>, (sent ?? []) as ReadonlyArray<SteerSent>)
  const open = steerOpen(page.inspection as Inspection)
  if (!open && items.length === 0) return null
  return (
    <section className="run-steers" aria-label={STEER}>
      {items.length === 0 ? null : (
        <ol className="run-steers-list">
          {items.map((item) => {
            const response = item.deliveredAtMs === null ? null : responseStep(steps, item.deliveredAtMs)
            return (
              <li key={item.id} className="run-steer" data-state={item.state}>
                <p className="run-steer-body">{item.body}</p>
                <span className="run-steer-meta">
                  {item.by === null ? null : <span>{item.by}</span>}
                  <span data-slot="steer-state">
                    {item.reason === null ? WORDS[item.state] : `${WORDS[item.state]}: ${STEER_REFUSAL_WORDS[item.reason]}`}
                  </span>
                  {response === null ? null : (
                    <Button size="sm" variant="link" onClick={() => actions.inspectStep(response)}>{NEXT_STEP}</Button>
                  )}
                </span>
              </li>
            )
          })}
        </ol>
      )}
      {open ? <SteerComposer draft={view.steerDraft ?? ""} actions={actions} /> : null}
    </section>
  )
}

function SteerComposer({ draft, actions }: { draft: string; actions: RunsActions }) {
  return (
    <form
      className="run-steer-composer"
      onSubmit={(event) => {
        event.preventDefault()
        actions.steer()
      }}
    >
      <Textarea
        aria-label={STEER_LABEL}
        placeholder={STEER_LABEL}
        rows={2}
        value={draft}
        onChange={(event) => actions.setSteerDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          actions.steer()
        }}
      />
      <Button type="submit" disabled={draft.trim() === ""}>{STEER}</Button>
    </form>
  )
}
