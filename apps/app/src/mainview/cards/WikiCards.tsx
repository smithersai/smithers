/*
 * The Wiki's link cards (Librarian L5): the rail of one note as a card
 * (`wiki-links`) and the knowledge graph as a card (`wiki-graph`). The
 * agent's wiki.backlinks and wiki.graph embed these in the transcript at
 * conversation width (THE EMBED LAW); the human's wiki.backlinks embeds the
 * same rail card. Every row is the button door of wiki.open, dispatched
 * through onRunCommand with the note's path as its args, so a click runs
 * exactly what `/wiki.open <path>` runs. A `[[target]]` no note answers is
 * listed under Unresolved with no door: there is nothing to open.
 */
import { Button } from "@smthrs/ui"
import { lazy, Suspense } from "react"
import type { Card } from "../state/AppState"
import { WIKI_DISPLAY_NAME, WIKI_GRAPH_ALL_SCOPE } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

type WikiLinksCard = Extract<Card, { kind: "wiki-links" }>
type WikiGraphCard = Extract<Card, { kind: "wiki-graph" }>

export interface WikiCardActions {
  readonly onRunCommand: RunCommand
}

const KnowledgeGraphSurface = lazy(() =>
  import("../KnowledgeGraphSurface").then((module) => ({ default: module.KnowledgeGraphSurface }))
)

const NoteRows = ({
  label,
  rows,
  empty,
  onRunCommand
}: {
  readonly label: string
  readonly rows: ReadonlyArray<{ readonly path: string; readonly title: string }>
  readonly empty: string
} & WikiCardActions) => (
  <section className="wiki-links-group" data-testid={`wiki-links-${label.toLowerCase().replace(/\s+/g, "-")}`}>
    <h4 className="search-results-group-label">
      {label} · {rows.length}
    </h4>
    {rows.length === 0 ?
      <p className="world-card-empty">{empty}</p> :
      (
        <ol className="search-results-items">
          {rows.map((row) => (
            <li key={row.path} className="search-results-item">
              <div className="world-card-row">
                <Button
                  variant="ghost"
                  size="sm"
                  data-flow="wiki.open"
                  data-testid={`wiki-open-${row.path}`}
                  onClick={() => onRunCommand("wiki.open", row.path)}
                >
                  {row.title}
                </Button>
                <span className="world-card-path">{row.path}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
  </section>
)

export const WikiLinksCardBody = ({ card, onRunCommand }: { readonly card: WikiLinksCard } & WikiCardActions) => {
  const { payload } = card
  return (
    <div className="world-card-list wiki-links">
      <div className="world-card-row">
        <span className="world-card-path" data-testid="wiki-links-path">{payload.path}</span>
        <Button
          variant="ghost"
          size="sm"
          data-flow="wiki.open"
          data-testid="wiki-links-open"
          onClick={() => onRunCommand("wiki.open", payload.path)}
        >
          Open
        </Button>
      </div>
      <NoteRows label="Backlinks" rows={payload.backlinks} empty="No backlinks yet" onRunCommand={onRunCommand} />
      <NoteRows label="Links out" rows={payload.linksOut} empty="No outgoing links yet" onRunCommand={onRunCommand} />
      {payload.unresolved.length === 0 ? null : (
        <section className="wiki-links-group" data-testid="wiki-links-unresolved">
          <h4 className="search-results-group-label">Unresolved · {payload.unresolved.length}</h4>
          <ol className="search-results-items">
            {payload.unresolved.map((target) => (
              <li key={target} className="search-results-item">
                <span className="world-card-path">[[{target}]]</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

export const WikiGraphCardBody = ({ card, onRunCommand }: { readonly card: WikiGraphCard } & WikiCardActions) => {
  const { payload } = card
  const missing = payload.notes.filter((note) => note.missing).length
  return (
    <div className="world-card-list wiki-graph">
      <div className="world-card-row">
        <span className="world-card-path" data-testid="wiki-graph-scope">
          {payload.path === null ? WIKI_GRAPH_ALL_SCOPE : `Around ${payload.path}`} · {payload.notes.length - missing} note
          {payload.notes.length - missing === 1 ? "" : "s"} · {payload.links.length} link{payload.links.length === 1 ? "" : "s"}
          {missing === 0 ? "" : ` · ${missing} unresolved`}
        </span>
        <Button
          variant="ghost"
          size="sm"
          data-flow="wiki.graph"
          data-testid="wiki-graph-rerun"
          onClick={() => onRunCommand("wiki.graph", payload.path ?? undefined)}
        >
          Refresh
        </Button>
      </div>
      {payload.notes.length === 0 ?
        <p className="world-card-empty" data-testid="wiki-graph-empty">{WIKI_DISPLAY_NAME} is empty so far.</p> :
        (
          <div className="wiki-graph-canvas">
            <Suspense fallback={<p className="smithers-card-note">Loading graph…</p>}>
              <KnowledgeGraphSurface
                notes={payload.notes.map((note) => ({
                  path: note.path,
                  title: note.title,
                  linksOut: [...note.linksOut],
                  backlinks: [...note.backlinks],
                  ...(note.missing ? { frontmatter: { missing: true } } : {})
                }))}
                links={payload.links}
                height={320}
                onOpenNote={(path) => onRunCommand("wiki.open", path)}
              />
            </Suspense>
          </div>
        )}
    </div>
  )
}

/** The family slice: the two kinds this file owns. */
export const wikiCardFamily: CardFamily<"wiki-links" | "wiki-graph"> = {
  "wiki-links": {
    render: (card, actions) => <WikiLinksCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  },
  "wiki-graph": {
    render: (card, actions) => <WikiGraphCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
