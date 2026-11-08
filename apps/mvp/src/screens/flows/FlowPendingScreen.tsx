import { PageBody, PageHeader } from "@smthrs/ui"
import { Link } from "@tanstack/react-router"
import "./flow-pending.css"

// A flow's editor waits on this device's editor storage and its engine before it can show (`beforeLoad` in
// src/router.tsx). Keep its navigation frame while it opens, without a loading state (0002 §7).
export function FlowPendingScreen() {
  return (
    <main className="flow-pending-screen" aria-label="Flows">
      <PageHeader width="narrow" back={<Link to="/app/flows">Flows</Link>} />
      <PageBody width="narrow" />
    </main>
  )
}
