import type { Contribution, Host } from "@smthrs/plugin"
import { Card, CardContent, EmptyState } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { useAuth } from "../../features/auth/components/AuthContext"
import { contributionViewer } from "../../features/auth/viewer"
import { useRepoAnswer } from "../../features/repo/components/RepoContext"
import { ActionStrip } from "../../plugins/components/ActionStrip"
import { Contributed } from "../../plugins/components/Contributed"
import { usePlugins } from "../../plugins/components/PluginsContext"

// A plugin's view at its full size with the host's action strip under it, on the app's page or a repository's. A
// signed-out visitor may sign in here; a signed-in viewer below the view's minimum sees nothing of it. On a
// repository's page the minimum is the person's role there (decision 0079), not on the deployment's own repository.
export function PluginView({ view, repository }: { readonly view: Contribution.View; readonly repository?: Host.Repository }) {
  const { actions } = usePlugins()
  const auth = useAuth()
  const { data: session } = useLiveQuery(auth.queries.session)
  const { data: confirmed } = useLiveQuery(auth.queries.confirmed)
  const answer = useRepoAnswer(repository?.owner ?? "", repository?.name ?? "")
  if (session === undefined) return null
  const viewer = contributionViewer(session, confirmed, repository === undefined ? undefined : { answer })
  if (!actions.allows(view.minimum, viewer) || view.render.kind !== "component") {
    return session.status === "signed_out"
      ? (
        <Card className="plugin-screen-signin">
          <CardContent>
            <EmptyState title={`Sign in to ${view.title.toLowerCase()}.`} action={<SignInButton />} />
          </CardContent>
        </Card>
      )
      : null
  }
  return (
    <>
      <div className="plugin-screen-view">
        <Contributed plugin={view.plugin} name={view.render.export} repository={repository} />
      </div>
      <ActionStrip view={view} />
    </>
  )
}
