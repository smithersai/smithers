import { Button, Wordmark } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useAuth } from "../../features/auth/components/AuthContext"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { Link } from "@tanstack/react-router"
import "./landing.css"

const SOURCE_URL = "https://github.com/smithersai/smithers"

export function Landing() {
  const { queries } = useAuth()
  const { data: session } = useLiveQuery(queries.session)
  return (
    <div className="landing">
      <nav className="landing-top" aria-label="Site">
        <a href="/docs">Docs</a>
        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">Source</a>
        {session?.status === "signed_in" ? null : <SignInButton />}
      </nav>
      <div className="landing-hero">
        <header className="landing-header">
          <h1 className="landing-title" aria-label="Smithers">
            <Wordmark />
          </h1>
        </header>
        <main className="landing-body">
          <p className="landing-tagline">Automate maintaining your codebase</p>
          <nav className="landing-actions" aria-label="Start">
            <Button asChild variant="solid" size="lg">
              <Link to="/app">Get started for free</Link>
            </Button>
          </nav>
        </main>
      </div>
      <footer className="landing-footer">
        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
      </footer>
    </div>
  )
}
