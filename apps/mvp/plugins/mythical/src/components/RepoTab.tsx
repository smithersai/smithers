import type { Host } from "@smthrs/plugin"
import { useSyncExternalStore } from "react"
import type { MythicalTab, Watched } from "../tab"

const useWatched = <A,>(watched: Watched<A>): A => useSyncExternalStore(watched.subscribe, watched.current)

export function RepoTab({ tab, repository }: { readonly tab: MythicalTab; readonly repository?: Host.Repository | undefined }) {
  if (repository === undefined) return null
  return <RepoTabLink tab={tab} repository={repository} />
}

function RepoTabLink({ tab, repository }: { readonly tab: MythicalTab; readonly repository: Host.Repository }) {
  const count = useWatched(tab.queries.count(repository))
  return (
    <a
      href={tab.actions.href(repository)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
        event.preventDefault()
        tab.actions.open(repository)
      }}
    >
      History{count > 0 ? ` (${count})` : ""}
    </a>
  )
}
