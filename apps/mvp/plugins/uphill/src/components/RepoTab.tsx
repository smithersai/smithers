import type { Host } from "@smthrs/plugin"
import { Badge, Button, isPlainNavigationClick } from "@smthrs/ui"
import { useSyncExternalStore } from "react"
import type { UphillTab } from "../tab"
import "./uphill.css"

const badgeVariant = (band: string): "success" | "warning" | "destructive" | "muted" => {
  if (band === "good") return "success"
  if (band === "warn") return "warning"
  if (band === "poor" || band === "failed") return "destructive"
  return "muted"
}

// The Uphill tab in a repository's header (`repo.tabs`): shown whenever the repository publishes an `uphill` feed,
// with its live overall 0–100 score badge.
export function RepoTab({ tab, repository }: { readonly tab: UphillTab; readonly repository?: Host.Repository | undefined }) {
  if (repository === undefined) return null
  return <Shown tab={tab} repository={repository} />
}

function Shown({ tab, repository }: { readonly tab: UphillTab; readonly repository: Host.Repository }) {
  const watched = tab.queries.summary(repository)
  const summary = useSyncExternalStore(watched.subscribe, watched.current)
  if (!summary.hasFeed) return null
  return (
    <Button asChild variant="ghost">
      <a
        className="uphill-plugin-tab-link"
        href={tab.actions.href(repository)}
        onClick={(event) => {
          if (!isPlainNavigationClick(event)) return
          event.preventDefault()
          tab.actions.open(repository)
        }}
      >
        <span>Uphill</span>
        {summary.overall !== null ? (
          <Badge variant={badgeVariant(summary.band)}>{summary.overall}</Badge>
        ) : null}
      </a>
    </Button>
  )
}
