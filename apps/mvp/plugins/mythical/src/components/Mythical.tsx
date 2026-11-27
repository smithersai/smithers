import type { Host } from "@smthrs/plugin"
import { Badge, EmptyState, Skeleton } from "@smthrs/ui"
import { useSyncExternalStore } from "react"
import type { MythicalTab, Watched } from "../tab"
import "./mythical.css"

const useWatched = <A,>(watched: Watched<A>): A => useSyncExternalStore(watched.subscribe, watched.current)

const NOTE_LABELS: Readonly<Record<string, string>> = {
  decision: "Decision",
  evidence: "Evidence",
  abandoned: "Abandoned",
  folded: "Folded",
}

export function Mythical({ tab, repository }: { readonly tab: MythicalTab; readonly repository?: Host.Repository | undefined }) {
  if (repository === undefined) return <EmptyState title="Open a repository to view mythical history" />
  return <MythicalBody tab={tab} repository={repository} />
}

function MythicalBody({ tab, repository }: { readonly tab: MythicalTab; readonly repository: Host.Repository }) {
  const state = useWatched(tab.queries.state(repository))
  if (state.status === "loading") return <Skeleton />
  if (state.status === "refused") return <EmptyState title="Mythical history not available" />
  if (!state.hasFeed || state.commits.length === 0) {
    return (
      <EmptyState
        title="No mythical history recorded yet"
        description="Merge a pull request through Smithers Cloud or call mythical_history_record via MCP."
      />
    )
  }

  const selected = state.selected ?? state.commits[0]!

  return (
    <div className="mythical-view" aria-label="Mythical history">
      <nav className="mythical-sidebar" aria-label="Mythical commits by epic">
        <div className="mythical-sidebar-head">
          <Badge variant={state.treeEqualToMain ? "success" : "muted"}>
            {state.treeEqualToMain ? "Tree equal to main" : "Pending fold"}
          </Badge>
          <Badge variant="muted">{state.commits.length} commits</Badge>
        </div>

        {state.epics.map((group) => (
          <section key={group.epic}>
            <p className="mythical-epic-title">{group.epic}</p>
            <ul className="mythical-commit-list">
              {group.commits.map((commit) => (
                <li key={commit.position}>
                  <button
                    type="button"
                    className="mythical-commit-btn"
                    aria-current={commit.position === selected.position ? "page" : undefined}
                    onClick={() => tab.actions.select(repository, commit.position)}
                  >
                    <span className="mythical-pos">#{commit.position}</span>
                    <span>{commit.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>

      <article className="mythical-detail">
        <header className="mythical-detail-head">
          <div className="mythical-meta">
            <Badge variant="secondary">{selected.epic}</Badge>
            <Badge variant="muted">#{selected.position}</Badge>
            {selected.commitSha ? <Badge variant="muted">{selected.commitSha.slice(0, 8)}</Badge> : null}
            {selected.prNumber !== null ? <Badge variant="muted">PR #{selected.prNumber}</Badge> : null}
            {selected.treeEqualToMain ? <Badge variant="success">Tree equal to main</Badge> : null}
            <Badge variant="muted">@{selected.authorLogin}</Badge>
          </div>
          <h2>{selected.title}</h2>
        </header>

        {selected.summary ? <p className="mythical-summary">{selected.summary}</p> : null}

        <section className="mythical-notes" aria-label="Commit notes">
          <h3>Git notes and evidence</h3>
          {selected.notes.length === 0 ? (
            <p className="mythical-summary">No notes attached to this commit yet.</p>
          ) : (
            selected.notes.map((note, idx) => (
              <div key={`${note.kind}-${idx}`} className="mythical-note-card">
                <Badge variant={note.kind === "abandoned" ? "warning" : note.kind === "evidence" ? "success" : "secondary"}>
                  {NOTE_LABELS[note.kind] ?? note.kind}
                </Badge>
                <span>{note.summary}</span>
                {note.ref ? <Badge variant="muted">{note.ref}</Badge> : null}
              </div>
            ))
          )}
        </section>
      </article>
    </div>
  )
}
