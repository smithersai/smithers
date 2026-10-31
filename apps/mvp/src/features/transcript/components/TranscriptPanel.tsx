import { ChatMessage, ChatTranscript, StatusPill, TaskItem } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useCallback } from "react"
import type { Item, Panel } from "../schema"
import { useTranscript } from "./TranscriptContext"

// A run's Transcript panel (decision 0134, docs/features/agent-transcripts.md#the-panel): what the run's external agent
// was asked, said and did, replayed from the start and then live. Every event is text; nothing renders as markup.

const PHASE: Readonly<Record<Panel["phase"], { readonly status: string; readonly label: string }>> = {
  idle: { status: "pending", label: "Waiting" },
  connecting: { status: "pending", label: "Connecting" },
  replaying: { status: "running", label: "Replaying" },
  live: { status: "running", label: "Live" },
  offline: { status: "waiting", label: "Reconnecting" },
  closed: { status: "failed", label: "Closed" },
}

const CLOSED: Readonly<Record<NonNullable<Panel["closed"]>, string>> = {
  authentication: "Sign in to watch this run.",
  forbidden: "Members can watch this run.",
  not_found: "This run has no transcript.",
  failed: "The transcript couldn't be reached.",
}

const ENDED: Readonly<Record<string, string>> = {
  done: "The agent finished.",
  cancelled: "The agent was stopped.",
  retryable: "The agent stopped; it will be started again.",
}

/** One item as the panel shows it. */
function Shown({ item }: { item: Item }) {
  switch (item.kind) {
    case "prompt":
      return <ChatMessage role="user" label="Prompt"><p className="transcript-text">{item.text}</p></ChatMessage>
    case "message":
      return <ChatMessage role="assistant"><p className="transcript-text">{item.text}</p></ChatMessage>
    case "thought":
      return <ChatMessage role="assistant" label="Thinking"><p className="transcript-text">{item.text}</p></ChatMessage>
    case "tool":
      return <TaskItem label={item.text === "" ? "Tool call" : item.text} status={item.status ?? "pending"} />
    case "plan":
      return (
        <ol className="transcript-plan" aria-label="Plan">
          {item.entries.map((entry, n) => <li key={n}><TaskItem label={entry.content} status={entry.status} /></li>)}
        </ol>
      )
    case "usage":
      return <p className="transcript-meta" data-kind="usage">{item.text}</p>
    case "turn":
      return <p className="transcript-meta" data-kind="turn">Turn ended: {item.text.replaceAll("_", " ")}</p>
    case "end":
      return (
        <ChatMessage role="system">
          <p className="transcript-text">{ENDED[item.text] ?? `The agent stopped: ${item.text.replace("failed:", "")}.`}</p>
        </ChatMessage>
      )
    case "other":
      return <p className="transcript-meta" data-kind={item.kind}>Transcript cut here: the run reached its size limit.</p>
  }
}

/** The transcript of run `runId`, live while the panel shows. */
export function TranscriptPanel({ runId }: { runId: string }) {
  const { queries, actions } = useTranscript()
  const { data: panel } = useLiveQuery(queries.panel)
  const { data: items } = useLiveQuery(queries.items)
  // The socket lives while the panel is on the page: its ref opens it, and the ref's cleanup lets go of it.
  const shown = useCallback((node: HTMLElement | null) => {
    if (node === null) return
    actions.watch(runId)
    return () => actions.watch(null)
  }, [actions, runId])
  const phase = PHASE[panel?.phase ?? "idle"]
  return (
    <section ref={shown} className="transcript-panel" aria-label="Transcript" data-phase={panel?.phase ?? "idle"}
      data-events={panel?.events ?? 0} data-verified={panel?.verified === null ? undefined : String(panel?.verified)}>
      <header className="transcript-header">
        <h2>Transcript</h2>
        <StatusPill status={phase.status} label={phase.label} />
      </header>
      {panel?.phase === "closed" && panel.closed !== null ? <p role="alert">{CLOSED[panel.closed]}</p> : null}
      <ChatTranscript aria-label="Transcript events"
        empty={<p className="transcript-meta">{panel?.phase === "live" ? "The agent hasn't said anything yet." : "Loading the transcript."}</p>}>
        {(items ?? []).map((item) => <Shown key={item.id} item={item} />)}
      </ChatTranscript>
    </section>
  )
}
