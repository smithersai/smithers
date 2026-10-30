import type { Contribution, Host } from "@smthrs/plugin"
import { useLiveQuery } from "@tanstack/react-db"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { useAuth } from "../../features/auth/components/AuthContext"
import { viewerOf } from "../../features/commands/catalog"
import { ActionStrip } from "../../plugins/components/ActionStrip"
import { Contributed } from "../../plugins/components/Contributed"
import { usePlugins } from "../../plugins/components/PluginsContext"

// A plugin's view at its full size with the host's action strip under it, on the app's page or a repository's. A
// signed-out visitor may sign in here; a signed-in viewer below the view's minimum sees nothing of it.
export function PluginView({ view, repository }: { readonly view: Contribution.View; readonly repository?: Host.Repository }) {
  const { actions } = usePlugins()
  const auth = useAuth()
  const { data: session } = useLiveQuery(auth.queries.session)
  const { data: confirmed } = useLiveQuery(auth.queries.confirmed)
  if (session === undefined) return null
  if (!actions.allows(view.minimum, viewerOf(session, confirmed)) || view.render.kind !== "component") {
    return session.status === "signed_out" ? <SignInButton /> : null
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
