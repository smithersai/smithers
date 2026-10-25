import { Card, EmptyState, IssuesView } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import type { ReactNode } from "react"
import { SignInButton } from "../../auth/components/SignInButton"
import { repoId } from "../../repo/contract"
import { githubList } from "../../repo/scope"
import { issuePath, NOT_FOUND } from "../contract"
import { embeddedIssues, listProps, syncsHere } from "../view"
import { useIssues } from "./IssuesContext"

// A repository's issues view in a conversation (docs/features/views.md#a-repository-and-its-issues): `IssuesView`,
// small, over the issues this device synced of `repo`, newest first. A row opens its issue full screen (`onOpen`);
// `fullScreen` is the view's action, the repository's issues page. A person who may not read them sees sign in, or Not
// found, and one this deployment doesn't sync a link to GitHub's list. The views' follower opens the repository's issues
// (src/features/views/embeds.ts, `IssuesStore.forRepo`); this only renders what the device has.
export function IssuesEmbed({
  repo,
  fullScreen,
  onOpen,
}: {
  readonly repo: string
  readonly fullScreen: ReactNode
  readonly onOpen: (href: string) => void
}) {
  const { queries } = useIssues()
  const [owner = "", name = ""] = repo.split("/")
  const id = repoId(owner, name)
  // Redrawn once the views' follower opened the repository's issues, which then reads its own rows.
  useLiveQuery(queries.opened)
  const { data: rows } = useLiveQuery(queries.newestFirstOf(id))
  const { data: synced } = useLiveQuery(queries.walkedOf(id))
  const { data: access } = useLiveQuery(queries.accessOf(id))
  const { data: unsynced } = useLiveQuery(queries.unsyncedOf(id))
  // Where this deployment doesn't sync the repository's issues, GitHub lists them, as on its page (decision 0079).
  if (!syncsHere(access, unsynced)) {
    const list = githubList(owner, name, "issues")
    return <Card className="issues-embed-refused"><p><a href={list.href}>{list.text}</a></p></Card>
  }
  const mine = embeddedIssues(rows, synced, id)
  const list = listProps(mine.rows, mine.synced, access)
  if (list.refused === "sign_in") return <Card className="issues-embed-refused"><SignInButton /></Card>
  if (list.refused !== undefined) {
    return (
      <Card className="issues-embed-refused">
        <EmptyState title={NOT_FOUND} action={fullScreen} />
      </Card>
    )
  }
  return (
    <IssuesView
      repo={repo}
      size="inline"
      issues={list.issues}
      unknown={list.unknown}
      href={(issue) => (issue.number === null ? undefined : issuePath(owner, name, issue.number))}
      onNavigate={(_, href) => onOpen(href)}
      actions={fullScreen}
    />
  )
}
