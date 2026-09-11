/*
 * The branches (bookmarks) card: INFORMATIONAL rows — bookmark name plus the
 * short head commit. A row binds no command: prs.create requires a title the
 * row cannot supply, so a button here could not carry a complete registered
 * invocation (the launch-law parity gate). The footer states the follow-up
 * command in words instead.
 */
import { GitBranch } from "lucide-react"
import type { Card } from "../state/AppState"
import type { CardFamily } from "./CardFamily"
import { settledPill } from "./CardFamily"

export const BranchesCardBody = ({
  card
}: {
  readonly card: Extract<Card, { kind: "branches" }>
}) => (
  <div className="world-card-list">
    <ul className="world-card-list">
      {card.payload.bookmarks.length === 0 ?
        <li className="world-card-empty">No branches in {card.payload.repo} yet.</li> :
        (
          card.payload.bookmarks.map((bookmark) => (
            <li key={bookmark.name} className="world-card-row">
              <GitBranch size={14} aria-hidden="true" />
              <span className="world-card-title">{bookmark.name}</span>
              {bookmark.head !== null ? <span className="world-card-path">{bookmark.head.slice(0, 8)}</span> : null}
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
  branches: { render: (card) => <BranchesCardBody card={card} />, pill: settledPill }
}
