import { useLiveQuery } from "@tanstack/react-db"
import { Link, useParams } from "@tanstack/react-router"
import { ConnectionPill } from "../../features/chat/components/ConnectionPill"
import { useAuth } from "../../features/auth/components/AuthContext"
import { viewerOf } from "../../features/commands/catalog"
import { ActionStrip } from "../../plugins/components/ActionStrip"
import { Contributed } from "../../plugins/components/Contributed"
import { usePlugins } from "../../plugins/components/PluginsContext"
import "./plugin-screen.css"

// /app/<plugin>/<path>: a plugin's view at its full size (decision 0017, `views`), with the host's action strip under
// it. A view the person may not see shows the page's header alone, as Settings does; no view at the path is the
// router's not-found.
export function PluginScreen() {
  const { plugin, _splat } = useParams({ strict: false }) as { readonly plugin: string; readonly _splat?: string }
  const { actions } = usePlugins()
  const auth = useAuth()
  const { data: session } = useLiveQuery(auth.queries.session)
  const { data: confirmed } = useLiveQuery(auth.queries.confirmed)
  const view = actions.viewAt(plugin, _splat ?? "")
  if (view === undefined || session === undefined) return null
  const allowed = actions.allows(view.minimum, viewerOf(session, confirmed))
  return (
    <main className="plugin-screen" aria-label={view.title} data-view={view.id}>
      <header className="plugin-screen-header">
        <Link to="/app">Back to chat</Link>
        <h1>{view.title}</h1>
        <div role="status" aria-label="Connection" aria-live="polite"><ConnectionPill /></div>
      </header>
      {allowed && view.render.kind === "component"
        ? (
          <>
            <div className="plugin-screen-view">
              <Contributed plugin={view.plugin} name={view.render.export} />
            </div>
            <ActionStrip view={view} />
          </>
        )
        : null}
    </main>
  )
}
