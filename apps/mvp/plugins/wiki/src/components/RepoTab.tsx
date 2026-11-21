import type { Host } from "@smthrs/plugin"
import { Button, isPlainNavigationClick } from "@smthrs/ui"
import { useSyncExternalStore } from "react"
import type { WikiTab } from "../tab"

// The wiki's tab in a repository's header (`repo.tabs`): shown whenever the repository publishes a wiki feed.
export function RepoTab({ tab, repository }: { readonly tab: WikiTab; readonly repository?: Host.Repository | undefined }) {
  if (repository === undefined) return null
  return <Shown tab={tab} repository={repository} />
}

function Shown({ tab, repository }: { readonly tab: WikiTab; readonly repository: Host.Repository }) {
  const watched = tab.queries.hasFeed(repository)
  const hasFeed = useSyncExternalStore(watched.subscribe, watched.current)
  if (!hasFeed) return null
  return (
    <Button asChild variant="ghost">
      <a
        href={tab.actions.href(repository)}
        onClick={(event) => {
          if (!isPlainNavigationClick(event)) return
          event.preventDefault()
          tab.actions.open(repository)
        }}
      >
        Wiki
      </a>
    </Button>
  )
}
