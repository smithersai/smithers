import { RepoView } from "@smthrs/repo-view"
import { Card, EmptyState } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import type { ReactNode } from "react"
import type { EmbedTarget } from "../embed"
import { embedHref, embedShown, fullScreenHref } from "../embedView"
import { useRepo } from "./RepoContext"

// A repository's view in a conversation (docs/features/views.md#a-repository-and-its-issues): the repository's own
// RepoView, small, at the location its row names: a directory with its README, or a file. Before anyone cloned it, its
// root as GitHub has it. Every link is the app's URL of a location; a plain click opens it full screen (`onOpen`), and
// `fullScreen(href)` is the view's action, opening what it shows. What it shows is loaded by the views' follower
// (src/features/views/embeds.ts); this only renders what the device has.
export function RepoEmbed({
  viewId,
  target,
  fullScreen,
  onOpen,
}: {
  readonly viewId: string
  readonly target: EmbedTarget
  readonly fullScreen: (href: string) => ReactNode
  readonly onOpen: (href: string) => void
}) {
  const { queries } = useRepo()
  const { data: rows } = useLiveQuery(queries.embeds)
  const row = rows.find((each) => each.embed.key === viewId)
  const shown = embedShown(row)
  const open = fullScreenHref(target, row)
  if (shown.kind === "empty") {
    return (
      <Card className="repo-embed-empty">
        <EmptyState title={shown.title} action={fullScreen(open)} />
      </Card>
    )
  }
  if (row === undefined || shown.kind === "loading") {
    return (
      <RepoView
        size="inline"
        name={target.repo.split("/")[1] ?? target.repo}
        tree={{ state: "loading" }}
        location={{ kind: "tree", path: "" }}
        href={() => open}
        onNavigate={() => onOpen(open)}
        actions={fullScreen(open)}
      />
    )
  }
  return (
    <RepoView
      size="inline"
      name={row.embed.name}
      tree={shown.tree}
      location={shown.location}
      file={shown.file}
      readme={shown.readme}
      href={(location) => embedHref(row.embed, shown, location)}
      onNavigate={(location) => onOpen(embedHref(row.embed, shown, location))}
      actions={fullScreen(open)}
    />
  )
}
