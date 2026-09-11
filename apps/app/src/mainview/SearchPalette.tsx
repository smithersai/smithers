/*
 * The search and command palette (Search and Command Palette Spec 2026-09-07
 * §1, §3, §9): ONE overlay anchored above the composer at composer width,
 * never a takeover (THE EMBED LAW). The slash tree is its `/` mode,
 * unchanged; every other prefix lists the seam's rows grouped as the ranking
 * left them; `→` or a second Cmd+K opens the actions panel for the
 * highlighted item, whose rows are registered flows. The composer's draft IS
 * the query, so closing the overlay never touches the draft (§3 Esc).
 *
 * This file is the overlay's projection and its keyboard contract as data:
 * the Composer owns the textarea and calls `paletteKey` on each keydown,
 * then performs the decision it returns through the controller. Nothing here
 * owns application state; the open state and the actions panel live on the
 * session row, and the highlight is presentation state the composer keeps.
 */
import type { SearchAction, SearchItem } from "@smthrs/rpc/Cards"
import type { CatalogItem } from "./flows/Commands"
import { Fragment } from "react"
import type { SlashRow } from "./flows/registry"
import { actionForKey, prefixRow } from "./flows/SearchQuery"
import type { PrefixRow } from "./flows/SearchQuery"
import type { PaletteAnswer } from "./state/seams/SearchSeam"

/** One selectable row of the overlay. */
export type PaletteRow =
  | { readonly kind: "slash"; readonly row: SlashLeafRow }
  | { readonly kind: "item"; readonly item: SearchItem; readonly group: string; readonly recommended: boolean }
  | { readonly kind: "action"; readonly action: SearchAction; readonly item: SearchItem }
  | { readonly kind: "help"; readonly row: PrefixRow & { readonly available: boolean } }

/** The overlay's rows for one draft, plus where each group starts (Tab walks groups). */
export interface PaletteRows {
  readonly rows: ReadonlyArray<PaletteRow>
  readonly groups: ReadonlyArray<{ readonly label: string; readonly start: number }>
  /** The item whose actions panel is showing, when it is among the current rows. */
  readonly actionsFor?: SearchItem
}

/** The legend the mock prints on the head line (§9). */
export const PALETTE_LEGEND = "↑↓ move · → actions · ?"

/** A slash row the overlay lists as a choice: a note is a caption, not a row. */
export type SlashLeafRow = Exclude<SlashRow<CatalogItem>, { readonly kind: "note" }>

export const paletteRows = (answer: PaletteAnswer, slashRows: ReadonlyArray<SlashRow<CatalogItem>>, actionsRef: string | null): PaletteRows => {
  if (answer.parsed.mode === "flows") {
    // A note row is a caption over the rows that follow it, never a choice: it renders as a group label.
    const rows: Array<PaletteRow> = []
    const groups: Array<{ label: string; start: number }> = []
    for (const row of slashRows) {
      if (row.kind === "note") groups.push({ label: row.text, start: rows.length })
      else rows.push({ kind: "slash", row })
    }
    return { rows, groups }
  }
  if (answer.help !== undefined) {
    return { rows: answer.help.map((row) => ({ kind: "help", row })), groups: [] }
  }
  const items = answer.groups.flatMap((group) => group.items.map((ranked) => ({ ...ranked, group: group.label })))
  const focus = actionsRef === null ? undefined : items.find((ranked) => ranked.item.ref === actionsRef)?.item
  if (focus !== undefined) {
    return {
      rows: focus.actions.map((action) => ({ kind: "action", action, item: focus })),
      groups: [{ label: focus.title, start: 0 }],
      actionsFor: focus
    }
  }
  const rows: Array<PaletteRow> = []
  const groups: Array<{ label: string; start: number }> = []
  for (const group of answer.groups) {
    groups.push({ label: group.label, start: rows.length })
    for (const ranked of group.items) rows.push({ kind: "item", item: ranked.item, group: group.label, recommended: ranked.recommended })
  }
  return { rows, groups }
}

/** What one key does with the overlay open (§3), decided from the rows and the highlight. */
export type PaletteDecision =
  | { readonly kind: "none" }
  | { readonly kind: "move"; readonly index: number }
  | { readonly kind: "open-namespace"; readonly id: string }
  | { readonly kind: "root" }
  | { readonly kind: "run-flow"; readonly name: string }
  | { readonly kind: "run-action"; readonly action: SearchAction; readonly item: SearchItem }
  | { readonly kind: "run-mode-flow"; readonly flow: string; readonly rest: string }
  | { readonly kind: "actions"; readonly ref: string }
  | { readonly kind: "close-actions"; readonly ref: string }
  | { readonly kind: "set-draft"; readonly draft: string }
  | { readonly kind: "close" }

export interface PaletteKeyInput {
  readonly key: string
  readonly meta: boolean
  readonly shift: boolean
  readonly draft: string
  readonly answer: PaletteAnswer
  readonly rows: PaletteRows
  readonly highlighted: number
  /** The draft is inside a `/ns.` branch (the slash tree's own back key). */
  readonly slashBranch: string | undefined
}

const wrap = (index: number, length: number): number => (length === 0 ? 0 : (index + length) % length)

/** The index of the first row of the group after (or before) the highlighted one. */
const nextGroupStart = (rows: PaletteRows, highlighted: number, direction: 1 | -1): number => {
  const starts = rows.groups.map((group) => group.start)
  if (starts.length === 0) return highlighted
  const current = starts.reduce((found, start, index) => (start <= highlighted ? index : found), 0)
  return starts[wrap(current + direction, starts.length)] ?? 0
}

export const paletteKey = (input: PaletteKeyInput): PaletteDecision => {
  const { key, meta, shift, rows, highlighted, answer, draft } = input
  const row = rows.rows[highlighted]
  const inActions = rows.actionsFor !== undefined
  if (key === "ArrowDown") return { kind: "move", index: wrap(highlighted + 1, rows.rows.length) }
  if (key === "ArrowUp") return { kind: "move", index: wrap(highlighted - 1, rows.rows.length) }
  if (key === "Tab") return { kind: "move", index: nextGroupStart(rows, highlighted, shift ? -1 : 1) }
  if (key === "Escape") {
    if (inActions && rows.actionsFor !== undefined) return { kind: "close-actions", ref: rows.actionsFor.ref }
    return { kind: "close" }
  }
  if (key === "ArrowRight" || (meta && key.toLowerCase() === "k")) {
    if (row?.kind === "slash" && row.row.kind === "namespace") return { kind: "open-namespace", id: row.row.namespace.id }
    if (row?.kind === "item" && row.item.actions.length > 0) return { kind: "actions", ref: row.item.ref }
    return { kind: "none" }
  }
  if (key === "ArrowLeft") {
    if (inActions && rows.actionsFor !== undefined) return { kind: "close-actions", ref: rows.actionsFor.ref }
    if (input.slashBranch !== undefined) return { kind: "root" }
    return { kind: "none" }
  }
  if (key === "Backspace") {
    const { prefix, query, mode } = answer.parsed
    if (mode === "flows" || draft.trimStart().slice(prefix.length).trim() !== "" || query !== "") return { kind: "none" }
    if (prefix !== "") return { kind: "set-draft", draft: "" }
    return draft === "" ? { kind: "close" } : { kind: "none" }
  }
  if (key === "Enter" && !shift) {
    const chosen = rows.rows.length === 1 ? rows.rows[0] : row
    if (chosen?.kind === "slash") {
      return chosen.row.kind === "namespace" ? { kind: "open-namespace", id: chosen.row.namespace.id } : { kind: "run-flow", name: chosen.row.flow.name }
    }
    if (chosen?.kind === "action") return { kind: "run-action", action: chosen.action, item: chosen.item }
    if (chosen?.kind === "help") return { kind: "set-draft", draft: chosen.row.prefix }
    if (chosen?.kind === "item") {
      const action = actionForKey(chosen.item, meta ? "primary" : "open")
      return action === undefined ? { kind: "none" } : { kind: "run-action", action, item: chosen.item }
    }
    // The `/` mode is the slash tree unchanged (§1, §3): with no slash row to choose, Enter is the composer's own send.
    if (answer.parsed.mode === "flows") return { kind: "none" }
    // No row to choose: the mode's flow runs with the query (signed out, that is where "Sign in to run" lands).
    if (answer.flow !== null) {
      return { kind: "run-mode-flow", flow: answer.flow, rest: draft.trimStart().slice(answer.parsed.prefix.length).trim() }
    }
    return { kind: "none" }
  }
  return { kind: "none" }
}

export interface PaletteOverlayProps {
  readonly answer: PaletteAnswer
  readonly rows: PaletteRows
  readonly highlighted: number
  readonly slashBranch: string | undefined
  readonly onHighlight: (index: number) => void
  readonly onChoose: (row: PaletteRow) => void
}

const roleWord = (role: SearchAction["role"]): string => (role === "open" ? "Enter" : role === "primary" ? "Cmd+Enter" : "")

/** The overlay: the head line, then the rows with their group labels, a refusal, or the prefix list. */
export function PaletteOverlay({ answer, rows, highlighted, slashBranch, onHighlight, onChoose }: PaletteOverlayProps) {
  const { parsed } = answer
  const chip = parsed.mode === "flows" ? "/" : prefixRow(parsed.mode).label
  const groupAt = new Map(rows.groups.map((group) => [group.start, group.label]))
  return (
    <div className="slash-menu" role="listbox" aria-label="Search palette" data-branch={slashBranch} data-mode={parsed.mode} data-testid="palette">
      <div className="palette-head">
        <span className="palette-chip" data-testid="palette-chip">{rows.actionsFor === undefined ? chip : "actions"}</span>
        <span className="palette-query">{rows.actionsFor?.title ?? parsed.query}</span>
        <span className="palette-legend">{PALETTE_LEGEND}</span>
      </div>
      {answer.refusal === undefined ? null : <p className="palette-refusal" data-testid="palette-refusal">{answer.refusal}</p>}
      {rows.rows.map((row, index) => {
        const label = groupAt.get(index)
        const highlightedRow = index === highlighted
        const common = {
          type: "button" as const,
          role: "option",
          "aria-selected": highlightedRow,
          "data-highlighted": highlightedRow ? "true" : "false",
          onMouseEnter: () => onHighlight(index)
        }
        const heading = label === undefined ? null : <div className="palette-group" key={`group:${label}:${index}`}>{label}</div>
        if (row.kind === "slash" && row.row.kind === "namespace") {
          const { namespace, count } = row.row
          return (
            <Fragment key={`ns:${namespace.id}`}>
              {heading}
              <button {...common} data-namespace={namespace.id} className="slash-menu-item slash-menu-namespace" onClick={() => onChoose(row)}>
                <span className="slash-menu-name">/{namespace.id} ›</span>
                <span className="slash-menu-description">
                  {namespace.label}
                  {namespace.summary === "" ? "" : ` — ${namespace.summary}`}
                </span>
                <span className="slash-menu-count">{count}</span>
              </button>
            </Fragment>
          )
        }
        if (row.kind === "slash" && row.row.kind === "flow") {
          const { flow, recommended } = row.row
          return (
            <Fragment key={flow.name}>
              {heading}
              <button {...common} data-gold={recommended} data-flow={flow.name} className="slash-menu-item" onClick={() => onChoose(row)}>
                <span className="slash-menu-name">/{flow.name}</span>
                <span className="slash-menu-description">{flow.summary}</span>
              </button>
            </Fragment>
          )
        }
        // Unreachable (a leaf row is a namespace or a flow); it narrows `row` for the branches below.
        if (row.kind === "slash") return null
        if (row.kind === "help") {
          const { prefix, label: shown, searches, available } = row.row
          return (
            <button {...common} key={`help:${shown}`} data-prefix={prefix} data-available={available} className="slash-menu-item palette-help-row" onClick={() => onChoose(row)}>
              <span className="slash-menu-name">{shown}</span>
              <span className="slash-menu-description">{available ? searches : "sign in"}</span>
            </button>
          )
        }
        if (row.kind === "action") {
          const { action } = row
          return (
            <button {...common} key={`action:${action.flow}:${action.args ?? ""}`} data-flow={action.flow} data-role={action.role} className="slash-menu-item" onClick={() => onChoose(row)}>
              <span className="slash-menu-name">/{action.flow}</span>
              <span className="slash-menu-description">{action.label}</span>
              <span className="slash-menu-count">{roleWord(action.role)}</span>
            </button>
          )
        }
        const { item, recommended } = row
        const primary = actionForKey(item, "primary")
        return (
          <div key={`item:${item.kind}:${item.ref}`} className="palette-item-wrap">
            {heading}
            <button {...common} data-kind={item.kind} data-ref={item.ref} data-gold={recommended} className="slash-menu-item" onClick={() => onChoose(row)}>
              <span className="slash-menu-name">{item.kind === "flow" ? `/${item.title}` : item.title}</span>
              {item.subtitle === undefined ? null : <span className="slash-menu-description">{item.subtitle}</span>}
              {primary === undefined ? null : <span className="slash-menu-count">Cmd+Enter</span>}
            </button>
          </div>
        )
      })}
    </div>
  )
}
