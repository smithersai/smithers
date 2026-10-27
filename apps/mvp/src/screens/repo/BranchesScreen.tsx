import { Badge, EmptyState, Skeleton } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link } from "@tanstack/react-router"
import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { useRepo } from "../../features/repo/components/RepoContext"
import { RepoPage } from "../../features/repo/components/RepoPage"
import { pageOf, refsProps } from "../../features/repo/view"
import "./repo-screen.css"

/** The repository browser's branch list, using the same visible refs as its picker. */
export function BranchesScreen() {
  const { queries } = useRepo()
  const { data: current } = useLiveQuery(queries.view)
  const { data: row } = useLiveQuery(queries.refs)
  const refs = refsProps(row?.refs)
  const page = pageOf(current)
  return (
    <main className="repo-screen" aria-label="Repository">
      <RepoHeader />
      <h2>Branches</h2>
      {page.kind !== "files" ? <RepoPage /> : refs.state === "loading" || current === undefined ? <Skeleton /> : refs.state === "failed" ? <EmptyState title={refs.message} /> : (
        <>
          {refs.branches.length === 0 ? <EmptyState title="No branches" /> : (
            <ul aria-label="Branches">
              {refs.branches.map((branch) => (
                <li key={branch.name}>
                  <Link to="/$owner/$repo/tree/$ref/$" params={{ owner: current.view.owner, repo: current.view.name, ref: branch.name, _splat: "" }}>{branch.name}</Link>
                  {branch.name === current.view.defaultBranch ? <> <Badge variant="secondary">default</Badge></> : null}
                </li>
              ))}
            </ul>
          )}
          {refs.truncated ? <span>More not shown</span> : null}
        </>
      )}
    </main>
  )
}
