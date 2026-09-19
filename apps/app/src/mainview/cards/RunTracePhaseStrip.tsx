import type { CSSProperties, PointerEvent } from "react"
import { flowAction, flowProps } from "../flows/FlowAction"
import { flowArgs } from "../flows/FlowArgs"
import type { RunCommand } from "./CardFamily"
import { durationWords, phaseBandGeometry, phaseExtent, type JournalRecord, type Milestone, type TraceExtent, type TraceModel } from "./RunTrace"

const BAND_NAMED = 12
const PIN_ROWS = 3
// Nearby anchors may share a disclosure. This is not a text-width estimate;
// layoutPins measures the rendered labels before assigning their actual rows.
const PIN_APART = 8
const TONE_RANK: Readonly<Record<Milestone["tone"], number>> = { brand: 0, good: 1, warn: 2, bad: 3 }
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)

export interface PhasePin {
  readonly milestone: Milestone
  readonly left: number
  readonly row: number
  readonly folded: ReadonlyArray<Milestone>
}

/** Group dense anchors; keep the doors and each disclosure in journal order. */
export const phasePins = (milestones: ReadonlyArray<Milestone>, extent: TraceExtent): ReadonlyArray<PhasePin> => {
  const axis = Math.max(extent.end - extent.start, 1)
  const rows: Array<Array<number>> = []
  const pins: Array<{ milestone: Milestone; left: number; row: number; folded: Array<Milestone> }> = []
  for (const milestone of [...milestones].filter((one) => one.label !== "").sort((a, b) => a.seq - b.seq)) {
    const left = clamp((milestone.at - extent.start) / axis * 100, 0, 100)
    const free = rows.findIndex((occupied) => occupied.every((anchor) => Math.abs(left - anchor) >= PIN_APART))
    const row = free >= 0 ? free : rows.length
    if (row >= PIN_ROWS) {
      // Append to the last door so disclosed members also precede the next
      // door in journal order, even when their timestamps run backwards.
      pins[pins.length - 1]!.folded.push(milestone)
    } else {
      ;(rows[row] ??= []).push(left)
      pins.push({ milestone, left, row, folded: [] })
    }
  }
  return pins
}

/** Timestamps can tie or regress. A selection belongs to the latest opened frame by sequence. */
export const frameAtSequence = (model: TraceModel, seq: number): string =>
  model.rows.filter((span) => span.kind === "frame" && (span.detail.sequence ?? Infinity) <= seq)
    .sort((a, b) => (b.detail.sequence ?? 0) - (a.detail.sequence ?? 0))[0]?.id ?? model.root.id

/**
 * Measure browser layout, including the loaded font and zoom, on mount and
 * resize. Only CSS geometry is written here; selection remains in the card.
 * The callback ref owns and releases its observer, with no React state/effect.
 */
const layoutPins = (container: HTMLDivElement | null): (() => void) | undefined => {
  if (container === null) return
  const pins = [...container.querySelectorAll<HTMLElement>(".run-phase-pin")]
  const labels = pins.map((pin) => pin.querySelector<HTMLElement>(".run-phase-pin-label")!)
  const measure = () => {
    const width = container.getBoundingClientRect().width
    if (width <= 0) return
    const boxes = labels.map((label) => label.getBoundingClientRect())
    const gap = 6
    const pitch = Math.max(...boxes.map((box) => box.height), 0) + gap
    const occupied: Array<Array<{ left: number; right: number }>> = []
    pins.forEach((pin, index) => {
      const box = boxes[index]!
      const anchor = Number(pin.dataset.pinLeft) / 100 * width
      const left = clamp(anchor - box.width / 2, 0, Math.max(0, width - box.width))
      const right = left + box.width
      const free = occupied.findIndex((row) => row.every((other) => left >= other.right + gap || right + gap <= other.left))
      const row = free < 0 ? occupied.length : free
      ;(occupied[row] ??= []).push({ left, right })
      pin.dataset.pinRow = String(row)
      pin.style.setProperty("--pin-shift", `${left - anchor}px`)
      pin.style.setProperty("--pin-top", `${row * pitch}px`)
      pin.style.setProperty("--pin-anchor", `${clamp(anchor, 0, width - 1) - left}px`)
      pin.style.setProperty("--pin-label-height", `${box.height}px`)
      pin.style.setProperty("--pin-menu-shift", `${-left}px`)
    })
    const height = Math.max(2, occupied.length) * pitch + gap
    container.style.height = `${height}px`
    container.style.setProperty("--pin-height", `${height}px`)
    container.style.setProperty("--pin-width", `${width}px`)
  }
  measure()
  if (typeof ResizeObserver === "undefined") return
  const observer = new ResizeObserver(measure)
  observer.observe(container)
  for (const label of labels) observer.observe(label)
  return () => observer.disconnect()
}

export interface TracePosition {
  readonly seq: number
  readonly left: number
}

/** Every recorded sequence stays a keyboard stop, including equal timestamps and journal gaps. */
export const tracePositions = (records: ReadonlyArray<JournalRecord>, extent: TraceExtent): ReadonlyArray<TracePosition> => {
  const ordered = [...new Map(records.flatMap((record) => Number.isSafeInteger(record.sequence) && record.sequence! >= 0
    ? [[record.sequence!, record] as const] : [])).values()].sort((a, b) => a.sequence! - b.sequence!)
  const axis = extent.end - extent.start
  return ordered.map((record, index) => {
    const payload = record.payload as { readonly at?: unknown } | undefined
    const at = typeof payload?.at === "number" && Number.isFinite(payload.at) ? payload.at : record.occurredAt
    const left = axis <= 0 || at === undefined || !Number.isFinite(at)
      ? index / Math.max(ordered.length - 1, 1) * 100
      : clamp((at - extent.start) / axis * 100, 0, 100)
    return { seq: record.sequence!, left }
  })
}

const nearestPosition = (positions: ReadonlyArray<TracePosition>, left: number): TracePosition | undefined =>
  positions.reduce<TracePosition | undefined>((best, one) => best === undefined || Math.abs(one.left - left) < Math.abs(best.left - left) ? one : best, undefined)

// In-flight pointer mechanics only. A settled gesture has no state here.
const drags = new WeakMap<HTMLElement, { readonly x: number; readonly bandSeq?: number; moved: boolean }>()

/** Whole-journal navigation; only the log below this strip stops at the persisted cursor. */
export const PhaseStrip = ({ model, records, runId, cursorSeq, onRunCommand }: {
  readonly model: TraceModel
  readonly records: ReadonlyArray<JournalRecord>
  readonly runId: string
  readonly cursorSeq: number | undefined
  readonly onRunCommand: RunCommand
}) => {
  const extent = phaseExtent(model)
  const pins = phasePins(model.milestones, extent)
  const positions = tracePositions(records, extent)
  if (model.bands.length === 0 && pins.length === 0) return null
  const reached = (seq: number) => cursorSeq === undefined || seq <= cursorSeq
  const current = [...positions].reverse().find((position) => position.seq <= (cursorSeq ?? Infinity)) ?? positions[0]
  const here = cursorSeq === undefined ? undefined : [...model.bands].reverse().find((band) => band.seq <= cursorSeq)
  const argsAt = (seq: number) => flowArgs("runs.trace.select", { runId, nodeId: frameAtSequence(model, seq), seq })
  const select = (seq: number) => onRunCommand("runs.trace.select", argsAt(seq))
  const preview = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const left = clamp((event.clientX - rect.left) / Math.max(rect.width, 1) * 100, 0, 100)
    event.currentTarget.style.setProperty("--scrub-preview", `${left}%`)
    return nearestPosition(positions, left)
  }
  const cancel = (element: HTMLElement) => {
    drags.delete(element)
    element.style.removeProperty("--scrub-preview")
  }
  return (
    <section className="run-phases" aria-label="Phases">
      {pins.length > 0 ? <div className="run-phase-pins" ref={(element) => layoutPins(element)}>
        {pins.map(({ milestone, left, row, folded }) => {
          const moments = [milestone, ...folded]
          const tone = moments.reduce((loudest, one) => TONE_RANK[one.tone] > TONE_RANK[loudest] ? one.tone : loudest, milestone.tone)
          const props = {
            "data-pin-row": row,
            "data-pin-left": left,
            "data-tone": tone,
            "data-reached": reached(milestone.seq),
            "aria-current": moments.some((one) => one.seq === cursorSeq) ? "location" as const : undefined,
            style: { left: `${left}%`, "--pin-row": String(row) } as CSSProperties
          }
          if (folded.length === 0) return <button key={`${milestone.seq}:${milestone.label}`} type="button" className="run-phase-pin" {...props}
            aria-label={`${milestone.label} · #${milestone.seq}`}
            {...flowAction(onRunCommand, "runs.trace.select", argsAt(milestone.seq))}>
            <span className="run-phase-pin-label">{milestone.label}</span>
            <span className="run-phase-pin-tick" aria-hidden />
          </button>
          return <details key={`${milestone.seq}:${milestone.label}`} className="run-phase-pin run-phase-cluster" {...props}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return
              event.preventDefault()
              event.currentTarget.open = false
              event.currentTarget.querySelector("summary")?.focus()
            }}>
            <summary aria-label={`${moments.length} milestones · #${milestone.seq}–#${moments.at(-1)!.seq}`}>
              <span className="run-phase-pin-label">+{moments.length}</span>
              <span className="run-phase-pin-tick" aria-hidden />
            </summary>
            <ol className="run-phase-members">
              {moments.map((one) => <li key={`${one.seq}:${one.label}`}>
                <button type="button" aria-label={`${one.label} · #${one.seq}`} aria-current={one.seq === cursorSeq ? "location" : undefined}
                  {...flowProps("runs.trace.select", argsAt(one.seq))}
                  onClick={(event) => {
                    const disclosure = event.currentTarget.closest("details")!
                    disclosure.open = false
                    disclosure.querySelector("summary")?.focus()
                    onRunCommand("runs.trace.select", argsAt(one.seq))
                  }}>
                  <span>{one.label}</span><span>#{one.seq}</span>
                </button>
              </li>)}
            </ol>
          </details>
        })}
      </div> : null}
      <div className="run-phase-track" style={{ "--scrub-position": `${current?.left ?? 100}%` } as CSSProperties}
        onPointerDown={(event) => {
          if (event.button !== 0 || positions.length === 0) return
          event.preventDefault()
          event.currentTarget.querySelector<HTMLElement>("[role=slider]")?.focus()
          const band = (event.target as HTMLElement).closest<HTMLElement>("[data-phase-band]")
          drags.set(event.currentTarget, { x: event.clientX, moved: false, ...(band === null ? {} : { bandSeq: Number(band.dataset.seq) }) })
          event.currentTarget.setPointerCapture(event.pointerId)
          preview(event)
        }}
        onPointerMove={(event) => {
          const drag = drags.get(event.currentTarget)
          if (drag === undefined || !event.currentTarget.hasPointerCapture(event.pointerId)) return
          drag.moved ||= Math.abs(event.clientX - drag.x) >= 3
          preview(event)
        }}
        onPointerUp={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          const drag = drags.get(event.currentTarget)
          const chosen = drag !== undefined && !drag.moved && drag.bandSeq !== undefined ? drag.bandSeq : preview(event)?.seq
          event.currentTarget.releasePointerCapture(event.pointerId)
          cancel(event.currentTarget)
          if (chosen !== undefined) select(chosen)
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          cancel(event.currentTarget)
        }}
        onLostPointerCapture={(event) => cancel(event.currentTarget)}
        onClickCapture={(event) => {
          // Pointer releases already committed. Native keyboard button clicks
          // keep the band's jump action and do not duplicate a drag command.
          if (event.detail > 0) { event.preventDefault(); event.stopPropagation() }
        }}>
        {model.bands.map((band, index) => {
          const bar = phaseBandGeometry(band, extent, index, model.bands.length)
          return <button key={`${band.seq}:${band.startedAt}`} type="button" className="run-phase-band"
            data-phase-band={band.phase} data-seq={band.seq} data-reached={reached(band.seq)}
            aria-current={band === here ? "location" : undefined}
            aria-label={`${band.phase} · ${durationWords(Math.max(band.endedAt - band.startedAt, 0))}`}
            style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
            {...flowAction(onRunCommand, "runs.trace.select", flowArgs("runs.trace.select", { runId, nodeId: band.frames[0] ?? model.root.id, seq: band.seq }))}>
            {bar.width >= BAND_NAMED ? <span className="run-phase-name">{band.phase}</span> : null}
          </button>
        })}
        {current === undefined ? null : <div className="run-phase-position" role="slider" tabIndex={0} aria-label="Run position"
          aria-valuemin={positions[0]!.seq} aria-valuemax={positions.at(-1)!.seq} aria-valuenow={current.seq}
          aria-valuetext={`#${current.seq}`} aria-orientation="horizontal"
          {...flowProps("runs.trace.select", argsAt(current.seq))}
          onKeyDown={(event) => {
            const index = positions.indexOf(current)
            const next = new Map([
              ["ArrowLeft", index - 1], ["ArrowDown", index - 1], ["ArrowRight", index + 1], ["ArrowUp", index + 1],
              ["Home", 0], ["End", positions.length - 1], ["PageUp", index + 10], ["PageDown", index - 10]
            ]).get(event.key)
            if (next === undefined) return
            event.preventDefault()
            const chosen = positions[clamp(next, 0, positions.length - 1)]!
            if (chosen !== current) select(chosen.seq)
          }}><span className="run-phase-cursor" aria-hidden /></div>}
      </div>
    </section>
  )
}
