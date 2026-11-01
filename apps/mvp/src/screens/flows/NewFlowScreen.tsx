import { PageBody, PageHeader } from "@smthrs/ui"
import { Link } from "@tanstack/react-router"
import { NewFlowCard } from "../../features/flows-ui/components/NewFlowCard"
import "./flows-screen.css"

// /app/flows/new: a new flow of your own, or the next revision of one (`?name=`), from what it should do.
export function NewFlowScreen() {
  return (
    <main className="flows-screen" aria-label="New flow">
      <PageHeader width="narrow" back={<Link to="/app/flows">Flows</Link>} />
      <PageBody width="narrow">
        <NewFlowCard />
      </PageBody>
    </main>
  )
}
