import { useCallback } from "react"
import { useRuns } from "../../features/runs/components/RunsContext"
import { Link, useParams } from "@tanstack/react-router"
import { RunPageView } from "../../features/runs/components/RunPageView"
import "./runs-screen.css"

// /app/runs/$runId: one run's page (decision 0014 §5); its route's loader reads it from this device's engine.
export function RunScreen() {
  const { runId } = useParams({ from: "/app/runs/$runId" })
  const { actions } = useRuns()
  const rendered = useCallback((node: HTMLElement | null) => { if (node !== null) actions.rendered(runId) }, [actions, runId])
  return (
    <main ref={rendered} className="runs-screen" aria-label="Run">
      <header className="runs-screen-header">
        <Link to="/app/runs">Runs</Link>
      </header>
      <RunPageView />
    </main>
  )
}
