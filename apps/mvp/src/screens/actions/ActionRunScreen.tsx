import { useCallback } from "react"
import { useRuns } from "../../features/runs/components/RunsContext"
import { Link, useParams } from "@tanstack/react-router"
import { actionsPath } from "../../features/actions/contract"
import { RunPageView } from "../../features/runs/components/RunPageView"
import "../runs/runs-screen.css"

// /$owner/$repo/actions/runs/$runId: one of the repository's runs, read and followed on Cloudflare
// (docs/features/actions.md); its route's loader opens it.
export function ActionRunScreen() {
  const { owner, repo, runId } = useParams({ from: "/$owner/$repo/actions/runs/$runId" })
  const { actions } = useRuns()
  const rendered = useCallback((node: HTMLElement | null) => { if (node !== null) actions.rendered(runId) }, [actions, runId])
  return (
    <main ref={rendered} className="runs-screen" aria-label="Run">
      <header className="runs-screen-header">
        <Link to={actionsPath(owner, repo) as never}>Runs</Link>
      </header>
      <RunPageView />
    </main>
  )
}
