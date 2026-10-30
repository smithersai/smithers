import type { Host } from "@smthrs/plugin"
import { Button } from "@smthrs/ui"
import type { FactoryTab } from "../tab"
import { useWatched, ViewLink } from "./parts"

// The factory's tab in a repository's header (`repo.tabs`): only on a repository that has a feed.
export function RepoTab({ tab, repository }: { readonly tab: FactoryTab; readonly repository?: Host.Repository | undefined }) {
  if (repository === undefined) return null
  return <Shown tab={tab} repository={repository} />
}

function Shown({ tab, repository }: { readonly tab: FactoryTab; readonly repository: Host.Repository }) {
  const feed = useWatched(tab.queries.feed(repository))
  if (feed._tag !== "Ready" || feed.documents === 0) return null
  return (
    <Button asChild variant="ghost">
      <ViewLink tab={tab} repository={repository} view="factory/now">Factory</ViewLink>
    </Button>
  )
}
