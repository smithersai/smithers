import type { Host } from "@smthrs/plugin"
import { BacklinksPanel, Badge, EmptyState, Input, Markdown, noteHref, OutlineView, Skeleton, useVaultCss, wikilinksToMarkdown } from "@smthrs/ui"
import { useSyncExternalStore } from "react"
import { groupNotes } from "../model"
import type { WikiTab, Watched } from "../tab"
import "./wiki.css"

const useWatched = <A,>(watched: Watched<A>): A => useSyncExternalStore(watched.subscribe, watched.current)

export function Wiki({ tab, repository }: { readonly tab: WikiTab; readonly repository?: Host.Repository | undefined }) {
  useVaultCss()
  if (repository === undefined) return <EmptyState title="Open a repository to browse its wiki" />
  return <WikiBody tab={tab} repository={repository} />
}

function WikiBody({ tab, repository }: { readonly tab: WikiTab; readonly repository: Host.Repository }) {
  const state = useWatched(tab.queries.state(repository))
  if (state.status === "loading") return <Skeleton />
  if (state.status === "refused") return <EmptyState title="Wiki not available" />

  const groups = groupNotes(state.filtered)
  const note = state.selected

  return (
    <div className="wiki-view" aria-label="Repository wiki">
      <nav className="wiki-sidebar" aria-label="Wiki notes">
        <Input
          type="search"
          aria-label="Filter wiki notes"
          placeholder="Filter notes…"
          value={state.query}
          onChange={(event) => tab.actions.search(repository, event.currentTarget.value)}
        />
        {!state.fromFeed ? <Badge variant="muted">Starter guide</Badge> : null}
        {groups.length === 0 ? (
          <p>No matching notes</p>
        ) : (
          groups.map((group) => (
            <section key={group.folder}>
              <p className="wiki-folder-title">{group.folder}</p>
              <ul className="wiki-note-list">
                {group.notes.map((candidate) => (
                  <li key={candidate.path}>
                    <button
                      type="button"
                      className="wiki-note-btn"
                      aria-current={candidate.path === note?.path ? "page" : undefined}
                      onClick={() => tab.actions.select(repository, candidate.path)}
                    >
                      {candidate.title}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </nav>

      <article className="wiki-main">
        {note === undefined ? (
          <EmptyState title="No note selected" />
        ) : (
          <>
            <header className="wiki-meta">
              <Badge variant="muted">{note.path}</Badge>
              {note.tags.map((tag) => (
                <Badge key={tag} variant="secondary">#{tag}</Badge>
              ))}
            </header>
            <Markdown content={wikilinksToMarkdown(note.markdown, (target) => noteHref(target))} />
          </>
        )}
      </article>

      <aside className="wiki-aside" aria-label="Note context">
        {note === undefined ? null : (
          <>
            <OutlineView markdown={note.markdown} />
            <BacklinksPanel
              backlinks={[...note.backlinks]}
              linksOut={[...note.linksOut]}
              onOpenNote={(path) => tab.actions.select(repository, path)}
            />
          </>
        )}
      </aside>
    </div>
  )
}
