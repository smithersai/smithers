/*
 * The per-family card renderer contract.
 *
 * ChatCards.tsx used to hold one render switch and one pill switch over every
 * card kind, so every lane that added a card kind edited the same file. Each
 * family of cards now exports a `CardFamily` slice from its own file: for each
 * kind it owns, how the body renders and which status pill the header wears.
 * CardRenderers.tsx spreads the slices into one record keyed by kind, and the
 * mapped type makes a missing kind a compile error. A new card kind is a body,
 * a slice entry in its family's file and one spread line in the aggregator.
 */
import type { ReactNode } from "react"
import type { MarkdownEditorHandle } from "@smthrs/ui/adapters/markdown-editor"
import type { FlowName } from "../flows/FlowName"
import type { Card, WorldDocument } from "../state/AppState"

/**
 * A card's act: the flow it names, and the slash line the flow's grammar
 * parses. The name is a FlowName rather than a string, so a card that asks for
 * `targets.select` no longer compiles; a structured act builds its line with
 * `flowArgs` (flows/FlowArgs.ts) rather than interpolating one of its own.
 */
export type RunCommand = (name: FlowName, args?: string) => void

/** The card of one kind. */
export type CardOf<K extends Card["kind"]> = Extract<Card, { kind: K }>

/**
 * Every act a card body may raise. Each is a flow the App binds at the
 * CardView mount; the body never owns application state.
 */
export interface CardActions {
  readonly onDecideApproval: (id: string, decision: "approved" | "denied") => void
  readonly onGrantConfirm: (id: string) => void
  readonly onGrantCancel: (id: string) => void
  readonly onQueueApprove: (login: string) => void
  readonly onConnectGitHub: () => void
  readonly onConnectLocal: () => void
  readonly onRunWorkflow: (name: string) => void
  /* Wave 12 — the run card's quiet-state acts and the which-repo answer. */
  readonly onStopRun: (cardId: string) => void
  readonly onRetryRun: (cardId: string) => void
  readonly onChooseWorkflowRepo: (fullName: string) => void
  /* The world card reads live documents so its editor never shows stale bodies. */
  readonly worldDocuments: ReadonlyArray<WorldDocument>
  readonly onChangeWorldDocument: (id: string, body: string) => void
  readonly onAttachWorldEditor?: (id: string, slot: string, editor: MarkdownEditorHandle | null) => void
  /*
   * The one delegated dispatch for the domain cards (issues, PRs,
   * notifications, env, import): every in-card act names its command and
   * routes through the registry at the App.tsx binding site.
   */
  readonly onRunCommand: RunCommand
  /*
   * Lane runs — the session's verbose flag, so the run card's Events tab (the
   * raw journal, a debug surface) exists only where verbose does.
   */
  readonly debugVerbose?: boolean
  /*
   * The identity seam's definitive signed-out answer. A card that is a public
   * read (the mythical history) renders its write doors only for a session
   * that can take them; signed out it is read-only and its one door is the
   * sign-in door. Unknown or unavailable identity never hides a door (gate on
   * answers, not on silence).
   */
  readonly signedOut?: boolean
}

/** How one card kind renders and which pill it wears. */
export interface CardFamilyEntry<K extends Card["kind"]> {
  /** The card body, mounted inside the shared card shell. */
  readonly render: (card: CardOf<K>, actions: CardActions) => ReactNode
  /**
   * The header's status word for a card whose `status` is not "error"
   * (an error card wears "failed" before any family is asked).
   */
  readonly pill: (card: CardOf<K>) => string
}

/** A family's slice of the renderer map: one entry per kind it owns. */
export type CardFamily<K extends Card["kind"]> = { readonly [P in K]: CardFamilyEntry<P> }

/** A listing that settles the moment it renders. */
export const settledPill = (): string => "done"

/** The pill of a card no family rule names: done once acted on, pending until then. */
export const defaultPill = (card: Card): string => (card.status === "acted" ? "done" : "pending")
