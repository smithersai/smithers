import { PageBody, PageHeader } from "@smthrs/ui"
import { useCallback } from "react"
import { useRuns } from "../../features/runs/components/RunsContext"
import { Link, useParams, useSearch } from "@tanstack/react-router"
import { actionsPath } from "../../features/actions/contract"
import { RunPageView } from "../../features/runs/components/RunPageView"
import "../runs/runs-screen.css"

// /$owner/$repo/actions/runs/$runId: one of the repository's runs, read and followed on Cloudflare
// (docs/features/actions.md); its route's loader opens it.
export function ActionRunScreen() {
  const { owner, repo, runId } = useParams({ from: "/$owner/$repo/actions/runs/$runId" })
  const { from } = useSearch({ from: "/$owner/$repo/actions/runs/$runId" })
  const { actions } = useRuns()
  const rendered = useCallback((node: HTMLElement | null) => { if (node !== null) actions.rendered(runId) }, [actions, runId])
  return (
    <main ref={rendered} className="runs-screen" aria-label="Run">
      <PageHeader
        width="wide"
        aria-label="Repository"
        back={<Link to="/$owner/$repo" params={{ owner, repo }}>{owner}/{repo}</Link>}
        nav={<Link to={(from === "runs" ? "/app/runs" : actionsPath(owner, repo)) as never}>Runs</Link>}
        navLabel="Run"
      />
      <PageBody width="wide">
        <RunPageView fromRuns={from === "runs"} />
      </PageBody>
    </main>
  )
}
