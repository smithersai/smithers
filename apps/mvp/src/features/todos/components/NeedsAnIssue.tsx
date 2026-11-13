import { Button } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useIssues } from "../../issues/components/IssuesContext"
import { useTodos } from "./TodosContext"
import { issueChoices, needsAnIssue } from "../view"
import type { Todo } from "../schema"

// Needs an issue (decision 0153): a TODO is a leaf under exactly one issue, so the stack lists, for Members, its open
// TODOs with no issue or a deleted one, each with Attach to issue. Attaching is a person's press (`todo/attach`).
export function NeedsAnIssue({ owner, name, repoId, todos }: {
  readonly owner: string
  readonly name: string
  readonly repoId: string
  readonly todos: ReadonlyArray<Todo>
}) {
  const issues = useIssues()
  useLiveQuery(issues.queries.opened)
  const { data: rows } = useLiveQuery(issues.queries.summariesOf(repoId))
  const orphans = needsAnIssue(repoId, todos, rows ?? [])
  if (orphans.length === 0) return null
  const choices = issueChoices(repoId, rows ?? [])
  return (
    <section className="stack-needs-issue" aria-label="Needs an issue">
      <h2 className="stack-needs-issue-title">Needs an issue ({orphans.length} {orphans.length === 1 ? "TODO" : "TODOs"})</h2>
      <ul className="stack-needs-issue-list">
        {orphans.map((todo) => <Orphan key={todo.id} owner={owner} name={name} todo={todo} choices={choices} />)}
      </ul>
    </section>
  )
}

function Orphan({ owner, name, todo, choices }: {
  readonly owner: string
  readonly name: string
  readonly todo: Todo
  readonly choices: ReadonlyArray<{ readonly number: number; readonly title: string }>
}) {
  const { queries, actions } = useTodos()
  const { data: selections } = useLiveQuery(queries.attachmentIssues)
  const issue = selections?.find((row) => row.id === todo.id)?.issue
  const label = `Issue for T${todo.number}`
  return (
    <li className="stack-needs-issue-row" data-todo={todo.number}>
      <span className="stack-needs-issue-label">T{todo.number} {todo.title}</span>
      <select
        aria-label={label}
        className="sui-input stack-needs-issue-select"
        value={issue === undefined ? "" : String(issue)}
        onChange={(event) => {
          const chosen = Number(event.currentTarget.value)
          actions.setAttachmentIssue(todo.id, chosen)
        }}
      >
        <option value="">Choose an issue</option>
        {choices.map((each) => <option key={each.number} value={String(each.number)}>{`#${each.number} ${each.title}`}</option>)}
      </select>
      <Button
        variant="outline"
        size="sm"
        disabled={issue === undefined}
        onClick={() => {
          if (issue !== undefined) void actions.attach(owner, name, todo.number, issue)
        }}
      >
        Attach to issue
      </Button>
    </li>
  )
}
