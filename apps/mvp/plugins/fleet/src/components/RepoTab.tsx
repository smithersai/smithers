import type { Host } from "@smthrs/plugin"
import { Button, isPlainNavigationClick } from "@smthrs/ui"
import type { FleetTab } from "../tab"
import { useWatched } from "./parts"

// The fleet's tab in a repository's header (`repo.tabs`), for its Maintainers: only on a repository with agent runs.
export function RepoTab({ tab, repository }: { readonly tab: FleetTab; readonly repository?: Host.Repository | undefined }) {
  if (repository === undefined) return null
  return <Shown tab={tab} repository={repository} />
}

function Shown({ tab, repository }: { readonly tab: FleetTab; readonly repository: Host.Repository }) {
  const runs = useWatched(tab.queries.runs(repository))
  if (runs._tag !== "Ready" || runs.rows.length === 0) return null
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
        Fleet
      </a>
    </Button>
  )
}
