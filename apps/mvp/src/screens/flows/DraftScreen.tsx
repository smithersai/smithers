import { PageBody, PageHeader } from "@smthrs/ui"
import { Link } from "@tanstack/react-router"
import { DraftCard } from "../../features/flows-ui/components/DraftCard"
import "./flows-screen.css"

// /app/flows/drafts/$draftId: one draft at full size; its route's loader shows it.
export function DraftScreen() {
  return (
    <main className="flows-screen" aria-label="Draft">
      <PageHeader back={<Link to="/app/flows">Flows</Link>} />
      <PageBody width="default">
        <DraftCard />
      </PageBody>
    </main>
  )
}
