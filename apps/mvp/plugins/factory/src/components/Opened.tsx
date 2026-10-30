import { DiffHunks, Markdown, parseUnifiedFile } from "@smthrs/ui"
import { commitDiffOf, reportOf, transcriptOf } from "../model"
import type { FactoryTab, Opened } from "../tab"
import { Close, useWatched } from "./parts"

// The document the person opened beside a view, in a panel over its right side (full width on a phone): a lane's live
// transcript, a commit's diff, or a review's Markdown. Esc or Close closes it; it follows the document while it shows.
export function OpenedPanel({ tab }: { readonly tab: FactoryTab }) {
  const opened = useWatched(tab.queries.opened)
  if (opened === null) return null
  return (
    <aside
      className="factory-panel"
      aria-label={opened.title}
      data-kind={opened.kind}
      onKeyDown={(event) => {
        if (event.key === "Escape") tab.actions.close()
      }}
    >
      <header className="factory-panel-header">
        <h2>{opened.title}</h2>
        <Close tab={tab} />
      </header>
      <div className="factory-panel-body">
        <Body opened={opened} />
      </div>
    </aside>
  )
}

function Body({ opened }: { readonly opened: Opened }) {
  if (opened.body === undefined) return <p className="factory-muted" role="status">Waiting for the collector</p>
  if (opened.body === null) return <p className="factory-muted" role="alert">Not available</p>
  if (opened.kind === "transcript") return <Transcript body={opened.body} />
  if (opened.kind === "diff") return <CommitDiff body={opened.body} />
  return <Markdown content={reportOf(opened.body)} variant="document" />
}

function Transcript({ body }: { readonly body: unknown }) {
  const transcript = transcriptOf(body)
  if (transcript.entries.length === 0) return <p className="factory-muted">Nothing yet</p>
  return (
    <ol className="factory-transcript" aria-label="Transcript" data-live={transcript.live}>
      {transcript.entries.map((entry, index) => (
        <li key={index} className="factory-entry" data-kind={entry.kind}>
          {entry.at === null ? null : <time className="factory-muted">{new Date(entry.at).toLocaleTimeString()}</time>}
          {entry.kind === "text" ? <Markdown content={entry.text} /> : <pre>{entry.text}</pre>}
        </li>
      ))}
    </ol>
  )
}

function CommitDiff({ body }: { readonly body: unknown }) {
  const diff = commitDiffOf(body)
  return (
    <div className="factory-diff">
      <pre className="factory-message">{diff.message}</pre>
      {diff.truncated ? <p className="factory-muted">Truncated</p> : null}
      {diff.files.map((patch, index) => {
        const file = parseUnifiedFile(patch)
        return (
          <section key={index} className="factory-diff-file" aria-label={file.path}>
            <h3>{file.path} <span className="factory-muted">+{file.add} −{file.del}</span></h3>
            <DiffHunks file={file} />
          </section>
        )
      })}
    </div>
  )
}
