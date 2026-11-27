import { Badge, Button, Card, CardContent, Wordmark } from "@smthrs/ui"
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
        <a href="https://ci.smithers.sh" target="_blank" rel="noopener noreferrer">CI</a>
        <a href="/docs">Docs</a>
        <Link to="/app/waitlist">Host a repo</Link>
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
              <Link to="/app">{session?.status === "signed_in" ? "Open Smithers" : "Get started for free"}</Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link to="/$owner/$repo" params={{ owner: "smithersai", repo: "smithers" }}>Explore live repo</Link>
            </Button>
          </nav>
          <section className="landing-paths" aria-label="Ways to contribute">
            <Card>
              <CardContent className="landing-path-card">
                <div className="landing-path-head">
                  <h2>Bring your own agent</h2>
                  <Badge variant="success">Free</Badge>
                </div>
                <p>Attach Claude Code, Codex, Antigravity, or Cursor locally over MCP.</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="landing-path-card">
                <div className="landing-path-head">
                  <h2>Fork &amp; maintain</h2>
                  <Badge variant="default">Your fork</Badge>
                </div>
                <p>Fork any repo in one click and work with full maintainer branches, stack, and PRs.</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="landing-path-card">
                <div className="landing-path-head">
                  <h2>Cloud sandboxes</h2>
                  <Badge variant="muted">Pay as you go</Badge>
                </div>
                <p>Run Cloudflare branch sandboxes, terminals, and CI jobs on prepaid credits (~$0.15/hr).</p>
              </CardContent>
            </Card>
          </section>
        </main>
      </div>
      <footer className="landing-footer">
        <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
      </footer>
    </div>
  )
}
