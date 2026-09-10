/*
 * The history card (Factory design session 2026-09-07 §3, mock 13): the
 * mythical history embedded in the chat. First-parent rows are epics with
 * their atomic commits under them and each commit's note beside it; the badge
 * is the invariant tree(mythical) == tree(main), or the honest reason it
 * cannot be checked. Until the bookmark exists the card is one sentence and
 * one door (history.bootstrap); the sentence carries "main has N commits."
 * only when a seam exposes the count. Every button is the button door of a
 * registered flow, dispatched through onRunCommand with its repo carried.
 *
 * The history is a public mirror read, so the card renders signed out too
 * (spec 03 §6 as amended 2026-09-07): read-only, with no write door. The
 * bootstrap door stays, because signed out it IS the sign-in door (the
 * requirement axis parks history.bootstrap behind auth.sign-in), and its
 * label says so; the fold door is a write and does not render signed out.
 */
import type { HistoryNote } from "@smthrs/rpc/Cards"
import { Button } from "@smthrs/ui"
import type { Card } from "../state/AppState"
import { emptyHistorySentence, treeEqualLabel } from "../state/seams/HistorySeam"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

type HistoryCard = Extract<Card, { kind: "history" }>
type NotesState = Extract<HistoryCard["payload"]["mythical"], { state: "present" }>["notes"]

/** The footer's notes pill: the ref, or the honest reason no note on the card is a claim. */
export const notesStateLabel = (notes: NotesState): string => {
  if (notes === "read") return "refs/notes/mythical"
  if (notes === "absent") return "refs/notes/mythical: not in the mirror's ref list"
  return "refs/notes/mythical: listed, but the mirror did not serve its notes (none shown)"
}

export interface HistoryCardActions {
  readonly onRunCommand: RunCommand
  /** The identity seam's definitive signed-out answer; undefined (unknown, unavailable) hides nothing. */
  readonly signedOut?: boolean
}

/** The one sentence beside a read-only history: why no write door renders. */
export const READ_ONLY_NOTE = "Read-only signed out: sign in to fold or amend."


const NoteSections = ({ note, sha }: { readonly note: HistoryNote; readonly sha: string }) => {
  const sections: ReadonlyArray<readonly [string, string | null]> = [
    ["Tried", note.tried],
    ["Evidence", note.evidence],
    ["Folded", note.folded],
    ["Superseded", note.superseded]
  ]
  const present = sections.filter((entry): entry is readonly [string, string] => entry[1] !== null && entry[1] !== "")
  if (present.length === 0) return null
  return (
    <dl className="history-note" data-testid={`history-note-${sha}`}>
      {present.map(([label, text]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{text}</dd>
        </div>
      ))}
    </dl>
  )
}

export const HistoryCardBody = ({ card, onRunCommand, signedOut = false }: { readonly card: HistoryCard } & HistoryCardActions) => {
  const { payload } = card
  const { mythical, repo } = payload
  if (mythical.state === "absent") {
    return (
      <div className="world-card-list">
        <p className="world-card-empty" data-testid="history-empty">
          {emptyHistorySentence(payload.defaultBookmark, payload.mainCommits)}
        </p>
        <Button
          variant="ghost"
          size="sm"
          data-flow="history.bootstrap"
          data-testid="history-bootstrap"
          onClick={() => onRunCommand("history.bootstrap", repo)}
        >
          {signedOut ? "Sign in to bootstrap the mythical history" : "Bootstrap the mythical history"}
        </Button>
      </div>
    )
  }
  if (mythical.state === "unsupported") {
    return (
      <div className="world-card-list">
        <p className="world-card-empty" data-testid="history-unsupported">{mythical.reason}</p>
      </div>
    )
  }
  return (
    <div className="world-card-list">
      <p className="world-card-path" data-testid="history-badge">
        {treeEqualLabel(mythical, payload.defaultBookmark)} · {mythical.epics.length} epic{mythical.epics.length === 1 ? "" : "s"} ·{" "}
        {mythical.commitCount} commit{mythical.commitCount === 1 ? "" : "s"}
      </p>
      {/* Each epic stacks: its header row, its note, then its atomic commits under it (mock 13). The li is a column, never a flex row. */}
      <ol className="history-epics" data-testid="history-epics">
        {mythical.epics.map((epic) => (
          <li key={epic.sha} className="history-epic" data-testid={`history-epic-${epic.sha}`}>
            <div className="world-card-row">
              <span className="world-card-title">{epic.title}</span>
              <span className="world-card-path">{epic.sha.slice(0, 7)}</span>
              {epic.commits.length === 0 ? null : <span className="world-card-path history-epic-count">{epic.commits.length}</span>}
            </div>
            {epic.note === null ? null : <NoteSections note={epic.note} sha={epic.sha} />}
            {epic.commits.length === 0 ? null : (
              <ol className="history-commits">
                {epic.commits.map((commit) => (
                  <li key={commit.sha} className="history-commit" data-testid={`history-commit-${commit.sha}`}>
                    <div className="world-card-row">
                      <span className="world-card-title">{commit.title}</span>
                      <span className="world-card-path">{commit.sha.slice(0, 7)}</span>
                    </div>
                    {commit.note === null ? null : <NoteSections note={commit.note} sha={commit.sha} />}
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ol>
      <div className="history-doors">
        {signedOut ?
          <span className="world-card-path" data-testid="history-read-only">{READ_ONLY_NOTE}</span> :
          (
            <Button
              variant="ghost"
              size="sm"
              data-flow="history.fold"
              data-testid="history-fold"
              onClick={() => onRunCommand("history.fold", repo)}
            >
              Fold {payload.defaultBookmark ?? "the default bookmark"} into mythical
            </Button>
          )}
        <span className="world-card-path" data-testid="history-notes-state">{notesStateLabel(mythical.notes)}</span>
      </div>
    </div>
  )
}

export const historyCardFamily: CardFamily<"history"> = {
  history: {
    render: (card, actions) => <HistoryCardBody card={card} onRunCommand={actions.onRunCommand} signedOut={actions.signedOut === true} />,
    pill: settledPill
  }
}
