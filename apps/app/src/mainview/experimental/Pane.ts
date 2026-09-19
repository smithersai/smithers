/*
 * The experimental pane contract.
 *
 * A pane is one hidden mock of an abstraction this repository already ships
 * but cannot show: `@smthrs/plan`'s keyed graph, `@smthrs/capability`'s rule
 * ladder, the harness cell loop's call ledger. The whole namespace exists
 * behind VITE_SMITHERS_EXPERIMENTAL, so nothing here reaches a person who did
 * not ask for it, and NO INVENTION does not bind a mock the way it binds a
 * shipped surface: a mock is a proposal, and its copy is the proposal.
 *
 * A pane carries its own mock data. It reads no collection, calls no seam and
 * dispatches no transition directly. Selections live in the card payload and
 * change through experimental.set; promotion earns the abstraction its own
 * live data, card kind and wire schema.
 */
import type { ReactNode } from "react"
import type { RunDynamicCommand } from "../cards/CardFamily"

/** What the shell tells a pane about its own presentation. */
export interface ExperimentalPaneContext {
  readonly cardId: string
  /** Persisted selections; each pane supplies defaults for absent keys. */
  readonly props: Readonly<Record<string, unknown>>
  /** Persist one selection through `experimental.set`. */
  readonly set: (key: string, value: string) => void
  /** Open another pane through its registered flow. */
  readonly onRunCommand: RunDynamicCommand
}

/** One hidden mock: its address, its catalog copy, and its body. */
export interface ExperimentalPane {
  /** The flow leaf: `/experimental.<id>`. Lowercase, hyphenated, unique. */
  readonly id: string
  /** The card title. */
  readonly title: string
  /** The slash-menu line, and the description the model reads. */
  readonly summary: string
  /** The packages this pane is a picture of. */
  readonly packages: ReadonlyArray<string>
  readonly render: (context: ExperimentalPaneContext) => ReactNode
}

/** Declares one pane. Identity is the file's own `id`, not its location. */
export const pane = (definition: ExperimentalPane): ExperimentalPane => definition
