import { flowAction } from "../flows/FlowAction"
import type { RunCommand } from "./CardFamily"
import type { RepositoryChoicePayload } from "../state/controller/tutorialRepository"

/** Native buttons keep Tab/Shift-Tab, Enter and Space; every act uses the shared flow dispatcher. */
export function RepositoryChoiceCard({ payload, onRunCommand }: {
  readonly payload: RepositoryChoicePayload
  readonly onRunCommand: RunCommand
}) {
  return <div data-testid="repository-choice">
    {payload.created ? <p>Created {payload.created.name} at {payload.created.path}</p> : <>
      {payload.error ? <p>{payload.error}</p> : null}
      <ol>{payload.repositories.map(repo => <li key={repo.fullName}>
        <button type="button"  aria-pressed={payload.selected === repo.fullName}
          {...flowAction(onRunCommand, "repo.choose", repo.fullName)}>{repo.fullName}</button>
        <span>{repo.latest === null ? "" : ` — pushed ${repo.latest.slice(0, 10)}`}</span>
        {repo.error ? <p>{repo.error}</p> : null}
      </li>)}</ol>
      <button type="button"  {...flowAction(onRunCommand, "repo.create", "smithers-playground")}>Skip</button>
    </>}
  </div>
}
