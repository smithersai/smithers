import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { HomeTabs } from "../../features/home/components/HomeTabs"
import { useParams } from "@tanstack/react-router"
import { useLiveQuery } from "@tanstack/react-db"
import { useAuth } from "../../features/auth/components/AuthContext"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { RepoRunsView } from "../../features/runs/components/RepoRunsView"
import "../runs/runs-screen.css"

// /$owner/$repo/actions: the repository's runs on Cloudflare (docs/features/actions.md).
export function ActionsScreen() {
  const { owner, repo } = useParams({ from: "/$owner/$repo/runs" })
  const { data: session } = useLiveQuery(useAuth().queries.session)
  return (
    <main className="runs-screen" aria-label="Runs"><RepoHeader /><HomeTabs />
      <header className="runs-screen-header">
        <h1>Runs</h1>
      </header>
      {session?.status === "signed_out" ? <SignInButton /> : <RepoRunsView owner={owner} name={repo} />}
    </main>
  )
}
