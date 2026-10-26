import { EmptyState, RelativeTime, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@smthrs/ui"
import { useSyncExternalStore } from "react"
import type { BugsTab, ErrorItem, Report } from "../tab"
import "./bugs.css"

// The inbox (docs/features/bugs.md#the-inbox): the reports the viewer may see, newest first, every one for an
// Admin and a person's own for anyone else. Each opens to its words, where it happened and the ids that find it in our
// records, and GitHub's prefilled form for it.
export function Inbox({ tab }: { readonly tab: BugsTab }) {
  const { reports } = tab.queries
  const rows = useSyncExternalStore(reports.subscribe, reports.current)
  if (rows.length === 0) return <EmptyState className="bugs-empty" title="No bug reports" />
  return (
    <ol className="bugs-inbox" aria-label="Bug reports">
      {rows.map((row) => <Entry key={row.id} row={row} />)}
    </ol>
  )
}

// The form's Send runs as a flow for the person; only the agent filing it for them is worth saying.
const who = (row: Report) => `@${row.reporterLogin ?? "someone"}${row.actedBy === "agent" ? " · agent" : ""}`

function Entry({ row }: { readonly row: Report }) {
  return (
    <li className="bugs-entry" data-report={row.id}>
      <details>
        <summary>
          <span className="bugs-entry-what">{row.what.split("\n", 1)[0]}</span>
          <span className="bugs-entry-meta">
            {who(row)} · {row.route ?? "unknown page"} · <RelativeTime ts={Date.parse(row.createdAt)} />
          </span>
        </summary>
        {/* The summary shows the first line; a longer report shows all of it here. */}
        {row.what.includes("\n") ? <p className="bugs-entry-words">{row.what}</p> : null}
        <dl className="bugs-entry-facts">
          <dt>Page</dt>
          <dd>{row.route ?? "unknown"}</dd>
          <dt>Build</dt>
          <dd>{row.build}</dd>
          <dt>Role</dt>
          <dd>{row.reporterRole ?? "none"}</dd>
          <dt>Browser</dt>
          <dd>{row.browser}</dd>
          <dt>Window</dt>
          <dd>{row.viewport}</dd>
          <dt>Traces</dt>
          <dd>{row.traces.length === 0 ? "none" : row.traces.join(" ")}</dd>
          <dt>Runs</dt>
          <dd>{row.runs.length === 0 ? "none" : row.runs.join(" ")}</dd>
          <dt>Failures</dt>
          <dd>{row.failures.length === 0 ? "none" : row.failures.map(({ flow, code }) => `${flow} ${code}`).join(", ")}</dd>
          <dt>Errors</dt>
          <dd>{row.errors.length === 0 ? "none" : <Errors errors={row.errors} />}</dd>
          <dt>Report</dt>
          <dd>{row.id}</dd>
        </dl>
        <a href={row.github} target="_blank" rel="noopener noreferrer">Open on GitHub</a>
      </details>
    </li>
  )
}

// What went wrong in the reporter's tab, newest first: the time (UTC), the kind, the record and its code, and the trace.
function Errors({ errors }: { readonly errors: ReadonlyArray<ErrorItem> }) {
  return (
    <Table className="bugs-entry-errors" aria-label="Errors">
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Record</TableHead>
          <TableHead>Code</TableHead>
          <TableHead>Trace</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {errors.map((error, index) => (
          <TableRow key={`${error.at}-${index}`}>
            <TableCell><time dateTime={error.at}>{error.at.slice(11, 19)}</time></TableCell>
            <TableCell>{error.kind}</TableCell>
            <TableCell>{error.name}</TableCell>
            <TableCell>{error.code ?? ""}</TableCell>
            <TableCell>{error.traceId ?? ""}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
