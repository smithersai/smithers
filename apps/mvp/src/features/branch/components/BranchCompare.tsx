import { Button, EmptyState } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { ChangedFiles } from "../../pulls/components/ChangedFiles"
import { CommitList } from "../../pulls/components/CommitList"
import { COMPARE, compareOf, type CompareView } from "../publishView"
import { useBranch } from "./BranchContext"
import "./publish.css"

// Compare (`?compare`, docs/features/branch-publish.md#the-branch-page): what the published branch's head adds to the
// base it was published from: its commits, then each file's diff, as a pull request's Commits and Files show them.
export function BranchCompare() {
  const { publishing } = useBranch()
  const { data: publication } = useLiveQuery(publishing.queries.publication)
  const { data: comparisons } = useLiveQuery(publishing.queries.comparisons)
  return <BranchCompareContent view={compareOf(publication, comparisons)} />
}

/** The comparison's receipts rendered with its partial lists. */
export function BranchCompareContent({ view }: { readonly view: CompareView }) {
  return (
    <section className="branch-compare" aria-label={COMPARE}>
      {view.kind === "loading"
        ? null
        : view.kind === "ready"
        ? (
          <>
            {view.truncated || view.commitsTruncated ? (
              <div role="status">
                <span>Incomplete comparison</span>{" "}
                <Button asChild variant="outline">
                  <a href={view.githubUrl} target="_blank" rel="noopener noreferrer">View on GitHub ↗</a>
                </Button>
              </div>
            ) : null}
            <CommitList commits={view.commits} />
            <ChangedFiles files={view.files} />
          </>
        )
        : <EmptyState title={view.title} />}
    </section>
  )
}
