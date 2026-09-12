/*
 * The branches (bookmarks) card: bookmark name plus the short head commit.
 * A row opens that branch's commits (commits.list <branch> <owner/repo>);
 * arrow keys, j and k move between rows. Opening a pull request needs a
 * title the row cannot supply, so the footer states that command in words.
 */
import { GitBranch } from "lucide-react"
import type { Card } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"
import { moveRowFocus } from "./CommitCards"

export const BranchesCardBody = ({
  card,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "branches" }>
  readonly onRunCommand: RunCommand
}) => (
  <div className="world-card-list">
    <ul className="world-card-list" onKeyDown={moveRowFocus}>
      {card.payload.bookmarks.length === 0 ?
        <li className="world-card-empty">No branches in {card.payload.repo} yet.</li> :
        (
          card.payload.bookmarks.map((bookmark) => (
            <li key={bookmark.name} className="world-card-row">
              <button
                type="button"
                className="branches-row-open"
                data-row-open
                data-flow="commits.list"
                aria-label={`Commits on ${bookmark.name}`}
                onClick={() => onRunCommand("commits.list", `${bookmark.name} ${card.payload.repo}`)}
              >
                <GitBranch size={14} aria-hidden="true" />
                <span className="world-card-title">{bookmark.name}</span>
                {bookmark.head !== null ? <span className="world-card-path">{bookmark.head.slice(0, 8)}</span> : null}
              </button>
            </li>
          ))
        )}
    </ul>
    {card.payload.bookmarks.length > 0 ?
      (
        <p className="world-card-path">
          Open a pull request with /prs.create {"<title>"} from:{"<branch>"}
        </p>
      ) :
      null}
  </div>
)

export const branchesCardFamily: CardFamily<"branches"> = {
  branches: { render: (card, actions) => <BranchesCardBody card={card} onRunCommand={actions.onRunCommand} />, pill: settledPill }
}
