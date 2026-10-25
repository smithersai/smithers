import { Link, useSearch } from "@tanstack/react-router"
import { FlowSummaryView } from "../../features/runs/components/FlowSummaryView"
import { RunListView } from "../../features/runs/components/RunListView"
import "./runs-screen.css"

// /app/runs: every run on this device and the runs on Cloudflare this person may read, newest first, like a CI system's
// runs (decision 0014 §5, ruling FLOW-13); its route's `beforeLoad` reads them.
export function RunsScreen() {
  const search = useSearch({ from: "/app/runs" })
  return (
    <main className="runs-screen" aria-label="Runs">
      <header className="runs-screen-header">
        <Link to="/app">Back to chat</Link>
        <h1>Runs</h1>
      </header>
      <FlowSummaryView flow={search.flow} />
      <RunListView flow={search.flow} open={search.open} />
    </main>
  )
}
