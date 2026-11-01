import { PageBody, PageHeader } from "@smthrs/ui"
import { Link } from "@tanstack/react-router"
import { FlowCodeCard } from "../../features/flows-ui/components/FlowCodeCard"
import "./flows-screen.css"

// /app/flows/code/$name: a flow's code at full size; its route's loader reads it.
export function CodeScreen() {
  return (
    <main className="flows-screen" aria-label="Code">
      <PageHeader width="wide" back={<Link to="/app/flows">Flows</Link>} />
      <PageBody width="wide">
        <FlowCodeCard />
      </PageBody>
    </main>
  )
}
