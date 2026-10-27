import { useLiveQuery } from "@tanstack/react-db"
import { useAuth } from "../../features/auth/components/AuthContext"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { Link } from "@tanstack/react-router"
import { FlowsPage } from "../../features/flows-ui/components/FlowsPage"
import "./flows-screen.css"

// /app/flows: your own flows and drafts (decision 0014 §5).
export function FlowsScreen() {
  const { data: session } = useLiveQuery(useAuth().queries.session)
  return (
    <main className="flows-screen" aria-label="Flows">
      <header className="flows-screen-header">
        <Link to="/app">Back to chat</Link>
        <h1>Flows</h1>
      </header>
      {session?.status === "signed_out" ? <SignInButton /> : <FlowsPage />}
    </main>
  )
}
