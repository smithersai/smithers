import { EmptyState, Skeleton } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { ChangedFiles } from "../../pulls/components/ChangedFiles"
import { CommitList } from "../../pulls/components/CommitList"
import { COMPARE, compareOf } from "../publishView"
import { useBranch } from "./BranchContext"
import "./publish.css"

// Compare (`?compare`, docs/features/branch-publish.md#the-branch-page): what the published branch's head adds to the
// base it was published from: its commits, then each file's diff, as a pull request's Commits and Files show them.
export function BranchCompare() {
  const { publishing } = useBranch()
  const { data: publication } = useLiveQuery(publishing.queries.publication)
  const { data: comparisons } = useLiveQuery(publishing.queries.comparisons)
  const view = compareOf(publication, comparisons)
  return (
    <section className="branch-compare" aria-label={COMPARE} aria-busy={view.kind === "loading"}>
      {view.kind === "loading"
        ? <Skeleton className="branch-compare-loading" />
        : view.kind === "ready"
        ? (
          <>
            <CommitList commits={view.commits} />
            <ChangedFiles files={view.files} />
          </>
        )
        : <EmptyState title={view.title} />}
    </section>
  )
}
