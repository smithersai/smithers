import type { Locator } from "@playwright/test"

/*
 * The run timeline, read two ways that never share code.
 *
 * `journalFrames` reads the gateway's own `run-events` rows and says what the
 * journal recorded about frames. The `read*` functions read what the card
 * rendered. A scenario compares the two, so the card's fold (RunTrace.ts) is
 * never its own oracle.
 */

/** The words a phase band may wear; the card spells them on `data-phase-band`. */
export const TIMELINE_PHASES: ReadonlyArray<string> = [
  "researching", "implementing", "testing", "stuck", "blocked", "unrecorded"
]

export type JournalRow = Readonly<Record<string, unknown>>

/** One frame, as the journal recorded it. */
export interface JournalFrame {
  /** 1-based ordinal. The card names this frame's node `frame-<n>`. */
  readonly frame: number
  /** Sequence of the record that opened the frame: where a band starting here scrubs to. */
  readonly opens: number
  /** Sequence of the first call the frame journaled. A frame that called nothing has no line. */
  readonly firstCall?: number
}

/** The node id the card gives a frame. */
export const frameNode = (frame: number): string => `frame-${frame}`

/**
 * The two journal kinds this oracle reads, as `@smthrs/agent` journals them.
 *
 * A control record's `kind` is the journal's event type, a different union from
 * a card's `kind`. The rows are decoded into `journalKind` below so the two are
 * never read through one name; the literal pin still checks both spellings
 * against the product source.
 */
const TURN_OPENED = "control.agent.turn-opened"
const CALL_STARTED = "control.agent.cell-call-started"

/**
 * The frames a journal opened, in order, and where each first called a flow.
 *
 * A queued checkpoint mint is bookkeeping, not something the frame did, so it
 * is not a call that earns the frame a line.
 */
export const journalFrames = (rows: ReadonlyArray<JournalRow>): ReadonlyArray<JournalFrame> => {
  const ordered = rows
    .flatMap((row) => {
      const { sequence, kind: journalKind, payload } = row
      return typeof sequence === "number" && typeof journalKind === "string" ? [{ sequence, journalKind, payload }] : []
    })
    .sort((left, right) => left.sequence - right.sequence)
  const frames: Array<{ frame: number; opens: number; firstCall?: number }> = []
  for (const record of ordered) {
    if (record.journalKind === TURN_OPENED) {
      frames.push({ frame: frames.length + 1, opens: record.sequence })
      continue
    }
    const open = frames[frames.length - 1]
    if (record.journalKind !== CALL_STARTED || open === undefined || open.firstCall !== undefined) continue
    const flowName = (record.payload as { readonly flowName?: unknown } | null | undefined)?.flowName
    if (typeof flowName === "string" && flowName !== "" && flowName !== "checkpoint") open.firstCall = record.sequence
  }
  return frames
}

/** The frames that have a line once the log is capped at `cursor`; every frame's line when nothing is parked. */
export const lineFramesAt = (frames: ReadonlyArray<JournalFrame>, cursor?: number): ReadonlyArray<number> =>
  frames
    .filter((entry) => entry.firstCall !== undefined && (cursor === undefined || entry.firstCall <= cursor))
    .map((entry) => entry.frame)

/** One door of the strip, as rendered. */
export interface StripDoor {
  readonly seq: number
  readonly reached: string | null
  readonly current: string | null
  readonly enabled: boolean
  readonly flow: string | null
  readonly args: string | null
}

export interface RenderedBand extends StripDoor {
  readonly phase: string | null
}

export interface RenderedPin extends StripDoor {
  readonly label: string
}

export interface RenderedLine {
  readonly node: string | null
  readonly number: string
  readonly verb: ReadonlyArray<string>
  readonly subject: ReadonlyArray<string>
  readonly result: ReadonlyArray<string>
  readonly flow: string | null
  readonly args: string | null
}

/** The phase strip: a labelled region, present only when the journal opened a frame or recorded a moment. */
export const phaseStrip = (trace: Locator): Locator => trace.getByRole("region", { name: "Phases", exact: true })

export const phaseBands = (trace: Locator): Locator => phaseStrip(trace).locator("button[data-phase-band]")

/** A pin carries its row; a band never does. */
export const phasePins = (trace: Locator): Locator => phaseStrip(trace).locator("button[data-pin-row]")

export const frameLines = (trace: Locator): Locator => trace.locator("button[data-frame-line]")

/** The frames the capped log still holds, as call-tree rows. */
export const treeFrames = (trace: Locator): Locator =>
  trace.getByRole("list", { name: "Call tree", exact: true }).locator('button[data-trace-span^="frame-"]')

export const readBands = (trace: Locator): Promise<ReadonlyArray<RenderedBand>> =>
  phaseBands(trace).evaluateAll((nodes) => nodes.map((node) => ({
    phase: node.getAttribute("data-phase-band"),
    seq: Number(node.getAttribute("data-seq")),
    reached: node.getAttribute("data-reached"),
    current: node.getAttribute("aria-current"),
    enabled: !(node as HTMLButtonElement).disabled,
    flow: node.getAttribute("data-flow"),
    args: node.getAttribute("data-flow-args")
  })))

/** A pin renders no seq of its own; the select flow's third argument is the seq it scrubs to. */
export const readPins = (trace: Locator): Promise<ReadonlyArray<RenderedPin>> =>
  phasePins(trace).evaluateAll((nodes) => nodes.map((node) => {
    const args = node.getAttribute("data-flow-args")
    return {
      label: (node.textContent ?? "").trim(),
      seq: Number((args ?? "").trim().split(/\s+/).pop()),
      reached: node.getAttribute("data-reached"),
      current: node.getAttribute("aria-current"),
      enabled: !(node as HTMLButtonElement).disabled,
      flow: node.getAttribute("data-flow"),
      args
    }
  }))

/** A list per part shows a missing or doubled part as itself. The card omits the subject of a call whose input names nothing. */
export const readLines = (trace: Locator): Promise<ReadonlyArray<RenderedLine>> =>
  frameLines(trace).evaluateAll((nodes) => nodes.map((node) => {
    const texts = (selector: string): ReadonlyArray<string> =>
      [...node.querySelectorAll(selector)].map((part) => (part.textContent ?? "").trim())
    return {
      node: node.getAttribute("data-frame-line"),
      number: texts(".run-line-number").join(" "),
      verb: texts(".run-line-verb"),
      subject: texts(".run-line-subject"),
      result: texts(".run-line-result"),
      flow: node.getAttribute("data-flow"),
      args: node.getAttribute("data-flow-args")
    }
  }))

/** What a scrub must leave alone: every band, in order, with its phase and the seq it opens at. */
export const bandIdentity = (bands: ReadonlyArray<RenderedBand>): ReadonlyArray<string> =>
  bands.map((band) => `${band.phase}@${band.seq}`)
