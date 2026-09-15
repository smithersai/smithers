import { useCallback, useState } from "react"
import type { Card } from "../state/AppState"
import { librarianRunCards, librarianRunKey, librarianRunMetadata, type LibrarianRunCard } from "../state/LibrarianLaunch"
import { useController } from "../ControllerContext"
import { readPause, type GuideClock } from "./advance"

const terminal = (run: LibrarianRunCard) => ["completed", "failed", "cancelled", "stopped"].includes(run.payload.phase)
const outcomeKey = (run: LibrarianRunCard) => `${librarianRunKey(run)}:${run.payload.phase}`

/** Notification dismissal is transient chrome; persisted run cards retain the outcome. */
export function LibrarianRunChips({ cards, clock }: { cards: readonly Card[]; clock: GuideClock }) {
  const controller = useController()
  // A reload or a new beat starts with old outcomes already read. Read the hydrated
  // collection directly: the live query may still return [] on its first render.
  const [read, setRead] = useState(() => new Set(librarianRunCards([...controller.store.collections.cards.values()]).filter(terminal).map(outcomeKey)))
  const onRead = useCallback((key: string) => setRead(previous => new Set([...previous, key])), [])
  const runs = librarianRunCards(cards).filter(run => !read.has(outcomeKey(run)))
  if (!runs.length) return null
  return <span className="guide-run-chips" aria-label="Background runs">
    {runs.map(run => <RunChip key={librarianRunKey(run)} run={run} clock={clock} onRead={onRead} />)}
  </span>
}

function RunChip({ run, clock, onRead }: { run: LibrarianRunCard; clock: GuideClock; onRead: (key: string) => void }) {
  const kind = librarianRunMetadata(run)!.kind
  const text = `${kind === "wiki" ? "Wiki" : "Mythical history"} ${run.payload.phase === "running" ? "started" : run.payload.phase} on ${run.payload.repo}`
  const key = outcomeKey(run)
  const settled = terminal(run)
  const bindRead = useCallback((node: HTMLSpanElement | null) => {
    if (!node || !settled) return
    const timer = clock.setTimeout(() => onRead(key), readPause(text))
    return () => clock.clearTimeout(timer)
  }, [clock, key, onRead, settled, text])
  return <span ref={bindRead} className="guide-run-chip" data-run-chip={kind} data-phase={run.payload.phase}>{text}</span>
}
