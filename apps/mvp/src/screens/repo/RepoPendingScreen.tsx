import { Button, Skeleton } from "@smthrs/ui"
import { Link, useParams } from "@tanstack/react-router"
import { OfflineFallback } from "../../features/navigation/components/OfflineFallback"
import "./repo-screen.css"

/** Pending routes use the URL, never a previous repository's rows. */
export function RepoPendingScreen() {
  const params = useParams({ strict: false })
  return (
    <main className="repo-screen" aria-label="Repository">
      <header className="repo-header" aria-label="Repository">
        <h1 className="repo-header-name">
          <Link to="/$owner/$repo" params={{ owner: params.owner!, repo: params.repo! }}>{params.owner} / {params.repo}</Link>
        </h1>
      </header>
      <OfflineFallback>
        <Button asChild variant="ghost"><Link to="/app">Back to chat</Link></Button>
        <Skeleton className="repo-page-loading" />
      </OfflineFallback>
    </main>
  )
}
