import { Button, EmptyState, Input, SegmentedControl } from "@smthrs/ui"
import { Link } from "@tanstack/react-router"
import { useLiveQuery } from "@tanstack/react-db"
import { useBranch } from "../../branch/components/BranchContext"
import { emptyTitle, paramsOf } from "../view"

// Your conversations (docs/features/conversations.md#the-list): one per branch you opened, the latest first, searched
// by repository and branch, with the archived ones one switch away. A row opens its branch, which brings an archived
// one back; Archive and Restore change only your own list, on all your devices.
export function ConversationList() {
  const { conversations } = useBranch()
  const { data: rows } = useLiveQuery(conversations.queries.list)
  const { data: search } = useLiveQuery(conversations.queries.search)
  const archived = search?.archived === true
  return (
    <section className="conversation-list">
      <div className="conversation-list-search">
        <Input
          type="search"
          aria-label="Search"
          placeholder="Search"
          value={search?.text ?? ""}
          onChange={(event) => void conversations.actions.search(event.currentTarget.value)}
        />
        <SegmentedControl
          aria-label="Show"
          value={archived ? "archived" : "open"}
          options={[{ value: "open", label: "Open" }, { value: "archived", label: "Archived" }]}
          onValueChange={(value) => void conversations.actions.showArchived(value === "archived")}
        />
      </div>
      {rows.length === 0
        ? search?.loaded === true ? <EmptyState title={emptyTitle(search.text, archived)} /> : null
        : (
          <ul className="conversation-list-rows" aria-label="Conversations">
            {rows.map((row) => (
              <li key={row.conversationId} className="conversation-list-row">
                <Link to="/$owner/$repo/tree/$ref/$" params={paramsOf(row)} search={{}}>
                  <span className="conversation-list-branch">{row.branch}</span>{" "}
                  <span className="conversation-list-repo">{row.repo}</span>
                </Link>
                <Button
                  variant="ghost"
                  aria-label={`${archived ? "Restore" : "Archive"} ${row.branch}`}
                  onClick={() => void conversations.actions.archive(row.conversationId, !archived)}
                >
                  {archived ? "Restore" : "Archive"}
                </Button>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}
