import { Button, Card, CardContent, EmptyState, Input, SegmentedControl } from "@smthrs/ui"
import { Link } from "@tanstack/react-router"
import { useLiveQuery } from "@tanstack/react-db"
import { useAuth } from "../../auth/components/AuthContext"
import { SignInButton } from "../../auth/components/SignInButton"
import { useBranch } from "../../branch/components/BranchContext"
import { archiveLabel, emptyTitle, paramsOf } from "../view"

// Your conversations (docs/features/conversations.md#the-list): one per branch you opened, the latest first, searched
// by repository and branch, with the archived ones one switch away. A row opens its branch, which brings an archived
// one back; Archive and Restore change only your own list, on all your devices. Signed out, the way in instead.
export function ConversationList() {
  const { conversations } = useBranch()
  const { data: session } = useLiveQuery(useAuth().queries.session)
  const { data: rows } = useLiveQuery(conversations.queries.list)
  const { data: search } = useLiveQuery(conversations.queries.search)
  const archived = search?.archived === true
  if (session?.status === "signed_out") {
    return (
      <section className="conversation-list">
        <Card>
          <CardContent>
            <EmptyState title="Sign in to see your conversations." action={<SignInButton />} />
          </CardContent>
        </Card>
      </section>
    )
  }
  return (
    <section className="conversation-list">
      <Card>
        <CardContent>
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
                      aria-label={archiveLabel(row, archived)}
                      onClick={() => void conversations.actions.archive(row.conversationId, !archived)}
                    >
                      {archived ? "Restore" : "Archive"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
        </CardContent>
      </Card>
    </section>
  )
}
