import { Card, EmptyState, IssuesView } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import type { ReactNode } from "react"
import { SignInButton } from "../../auth/components/SignInButton"
import { repoId } from "../../repo/contract"
import { issuePath, NOT_FOUND } from "../contract"
import { embeddedIssues, listProps } from "../view"
import { useIssues } from "./IssuesContext"

// A repository's issues view in a conversation (docs/features/views.md#a-repository-and-its-issues): `IssuesView`,
// small, over the issues this device synced of `repo`, newest first. A row opens its issue full screen (`onOpen`);
// `fullScreen` is the view's action, the repository's issues page. A person who may not read them sees sign in, or Not
// found. The views' follower starts the issues' sync (src/features/views/embeds.ts); this only renders what the device
// has.
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
  const { data: rows } = useLiveQuery(queries.allIssues)
  const { data: synced } = useLiveQuery(queries.syncedRepositories)
  const { data: access } = useLiveQuery(queries.access)
  const [owner = "", name = ""] = repo.split("/")
  const mine = embeddedIssues(rows, synced, repoId(owner, name))
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
