import { PageBody, PageHeader, Skeleton } from "@smthrs/ui"
import { Link } from "@tanstack/react-router"
import "./flow-pending.css"

// A flow's editor waits on this device's editor storage and its engine before it can show (`beforeLoad` in
// src/router.tsx). Until then the page keeps its frame and a skeleton where the card goes, never a blank window.
export function FlowPendingScreen() {
  return (
    <main className="flow-pending-screen" aria-label="Flows" aria-busy="true">
      <PageHeader width="narrow" back={<Link to="/app/flows">Flows</Link>} />
      <PageBody width="narrow">
        <Skeleton aria-label="Loading flow" className="flow-pending" />
      </PageBody>
    </main>
  )
}
