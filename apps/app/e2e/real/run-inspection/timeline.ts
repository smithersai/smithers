import type { Locator } from "@playwright/test"

/** DOM readings only. semantic.ts owns the independent journal expectations. */

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

export const frameLines = (trace: Locator): Locator => trace.locator("button[data-frame-line]")

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
  phaseStrip(trace).locator('.run-phase-pins button[data-flow]').evaluateAll((nodes) => nodes.map((node) => {
    const args = node.getAttribute("data-flow-args")
    return {
      label: (node.querySelector("span")?.textContent ?? "").trim(),
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

