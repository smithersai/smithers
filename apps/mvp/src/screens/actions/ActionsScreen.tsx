import { Card, CardContent, CardHeader, CardTitle, PageBody } from "@smthrs/ui"
import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { useParams } from "@tanstack/react-router"
import { useLiveQuery } from "@tanstack/react-db"
import { useAuth } from "../../features/auth/components/AuthContext"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { RepoFlowsView } from "../../features/runs/components/RepoFlowsView"
import { RepoRunsView } from "../../features/runs/components/RepoRunsView"
import "../runs/runs-screen.css"
import "./actions-screen.css"

// /$owner/$repo/actions: the repository's runs on Cloudflare, and its flows a Member runs by hand (docs/features/actions.md).
export function ActionsScreen() {
  const { owner, repo } = useParams({ from: "/$owner/$repo/runs" })
  const { data: session } = useLiveQuery(useAuth().queries.session)
  return (
    <main className="runs-screen actions-screen" aria-label="Runs"><RepoHeader />
      <PageBody width="wide">
        {session?.status === "signed_out" ? null : <RepoFlowsView />}
        <Card>
          <CardHeader>
            <CardTitle>Runs</CardTitle>
          </CardHeader>
          <CardContent>
            {session?.status === "signed_out"
              ? <div className="actions-sign-in"><SignInButton /></div>
              : <RepoRunsView owner={owner} name={repo} />}
          </CardContent>
        </Card>
      </PageBody>
    </main>
  )
}
