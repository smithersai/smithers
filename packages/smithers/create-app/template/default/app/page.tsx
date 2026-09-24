/**
 * The root page. `app/page.tsx` is the route `/`; `app/settings/page.tsx` would
 * be `/settings`. Nothing registers a page but its location.
 *
 * The composer posts to `/api/turn` and reads the `TurnFrame` NDJSON stream
 * back: `delta` text becomes the answer, each `card` renders through the pane
 * registry, and an `error` frame or a refused request shows as one line.
 *
 * The registry comes from `routes.ui.gen.ts`, imported when a turn starts: that
 * module imports this page, so a top-level import would close a cycle.
 */
import type { AppCard, PaneRegistry, TurnFrame } from "@smthrs/create-app/ui"
import { type ReactNode, useState } from "react"

interface Turn {
  readonly text: string
  readonly cards: ReadonlyArray<AppCard>
  readonly error?: string
}

const empty: Turn = { text: "", cards: [] }

const apply = (turn: Turn, frame: TurnFrame): Turn => {
  switch (frame.type) {
    case "delta":
      return { ...turn, text: turn.text + frame.text }
    case "card":
      return { ...turn, cards: [...turn.cards, frame.card] }
    case "card.update":
      return { ...turn, cards: turn.cards.map((card) => card.id === frame.card.id ? frame.card : card) }
    case "error":
      return { ...turn, error: frame.message }
    default:
      return turn
  }
}

const noContext = { fullscreen: false, maximize: () => {}, restore: () => {} }

const renderCard = (card: AppCard, panes: PaneRegistry): ReactNode => {
  if (card.kind !== "pane") return null
  const pane = panes[card.name]
  if (pane === undefined) return <p className="answer-error">No pane is routed as {card.name}</p>
  try {
    return pane.renderUnknown(card.props, noContext)
  } catch (cause) {
    return <p className="answer-error">{cause instanceof Error ? cause.message : String(cause)}</p>
  }
}

export default function Page() {
  const [message, setMessage] = useState("")
  const [turn, setTurn] = useState<Turn | undefined>(undefined)
  const [panes, setPanes] = useState<PaneRegistry>({})
  const [pending, setPending] = useState(false)

  const send = async () => {
    if (message.trim() === "") return
    setPending(true)
    setTurn(empty)
    try {
      setPanes((await import("../routes.ui.gen.ts")).panes)
      const response = await fetch("/api/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flow: "chat", payload: { message } })
      })
      if (!response.ok || response.body === null) {
        const body = await response.json().catch(() => undefined) as { message?: string } | undefined
        setTurn({ ...empty, error: body?.message ?? `HTTP ${response.status}` })
        return
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffered = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffered += value
        const lines = buffered.split("\n")
        buffered = lines.pop() ?? ""
        for (const line of lines) {
          if (line.length > 0) setTurn((current) => apply(current ?? empty, JSON.parse(line) as TurnFrame))
        }
      }
    } catch (cause) {
      setTurn({ ...empty, error: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="page">
      <h1>Chat</h1>
      <p className="page-lede">
        One flow, one pane, one tool. Edit <code>flows/chat/flow.ts</code> to change what the agent is asked, and{" "}
        <code>AGENT.ts</code> to change the seat it runs on.
      </p>
      <div className="composer">
        <input
          className="composer-input"
          value={message}
          placeholder="Ask something"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send()
          }}
        />
        <button className="composer-send" type="button" disabled={pending} onClick={() => void send()}>
          {pending ? "Running" : "Send"}
        </button>
      </div>
      {turn === undefined ? null : (
        <div className="answer">
          {turn.text === "" ? null : <p className="answer-text">{turn.text}</p>}
          {turn.cards.map((card) => <div key={card.id}>{renderCard(card, panes)}</div>)}
          {turn.error === undefined ? null : <p className="answer-error">{turn.error}</p>}
        </div>
      )}
    </section>
  )
}
