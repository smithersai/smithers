import type { Host } from "@smthrs/plugin"
import { EmptyState, Markdown, Skeleton, UphillScorecard } from "@smthrs/ui"
import { useSyncExternalStore } from "react"
import type { UphillTab, Watched } from "../tab"
import "./uphill.css"

const useWatched = <A,>(watched: Watched<A>): A => useSyncExternalStore(watched.subscribe, watched.current)

export function Uphill({ tab, repository }: { readonly tab: UphillTab; readonly repository?: Host.Repository | undefined }) {
  if (repository === undefined) return <EmptyState title="Open a repository to view Uphill scores" />
  return <UphillBody tab={tab} repository={repository} />
}

function UphillBody({ tab, repository }: { readonly tab: UphillTab; readonly repository: Host.Repository }) {
  const state = useWatched(tab.queries.state(repository))
  if (state.status === "loading") return <Skeleton />
  if (state.status === "refused") return <EmptyState title="Uphill report not available" />
  if (!state.hasFeed || state.envelope === undefined) {
    return (
      <EmptyState
        title="No Uphill report published"
        description="Run uphill and publish .uphill/report.json to this repository's uphill feed."
      />
    )
  }

  return (
    <div className="uphill-plugin-view" aria-label="Repository Uphill scorecard">
      <UphillScorecard
        report={state.envelope.report}
        commit={state.envelope.commit}
        branch={state.envelope.branch}
        history={state.history}
        selectedCategory={state.selectedCategory}
        onSelectCategory={(category) => tab.actions.selectCategory(repository, category)}
      />
      {state.envelope.rules ? (
        <section className="uphill-plugin-rules" aria-label="Uphill rules">
          <Markdown content={state.envelope.rules} />
        </section>
      ) : null}
    </div>
  )
}
