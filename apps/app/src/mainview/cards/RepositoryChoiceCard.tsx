import { flowAction } from "../flows/FlowAction"
import type { RunCommand } from "./CardFamily"
import type { RepositoryChoicePayload } from "../state/controller/tutorialRepository"

/** The recently pushed repositories a person sees at once; the rest wait behind a disclosure. */
export const RECENT_REPOSITORIES = 8

/** Native buttons keep Tab/Shift-Tab, Enter and Space; every act uses the shared flow dispatcher. */
export function RepositoryChoiceCard({ payload, onRunCommand }: {
  readonly payload: RepositoryChoicePayload
  readonly onRunCommand: RunCommand
}) {
  const row = (repo: RepositoryChoicePayload["repositories"][number]) => <li key={repo.fullName}>
    <button type="button" aria-pressed={payload.selected === repo.fullName}
      {...flowAction(onRunCommand, "repo.choose", repo.fullName)}>{repo.fullName}</button>
    <span>{repo.latest === null ? "" : ` — pushed ${repo.latest.slice(0, 10)}`}</span>
    {repo.error ? <p>{repo.error}</p> : null}
  </li>
  return <div data-testid="repository-choice">
    {payload.created ? <p>Created {payload.created.fullName}</p> : <>
      {payload.error ? <p>{payload.error}</p> : null}
      <ol>{payload.repositories.slice(0, RECENT_REPOSITORIES).map(row)}</ol>
      {/* The rest stay behind a native disclosure: the ranking already put the recently pushed ones first. */}
      {payload.repositories.length > RECENT_REPOSITORIES && <details>
        <summary>All repositories ({payload.repositories.length})</summary>
        <ol>{payload.repositories.slice(RECENT_REPOSITORIES).map(row)}</ol>
      </details>}
      <button type="button"  {...flowAction(onRunCommand, "repo.create", "smithers-playground")}>Skip</button>
    </>}
  </div>
}
