import { Link, useParams } from "@tanstack/react-router"
import { ConnectionPill } from "../../features/chat/components/ConnectionPill"
import { usePlugins } from "../../plugins/components/PluginsContext"
import { PluginView } from "./PluginView"
import "./plugin-screen.css"

// /app/<plugin>/<path>: a plugin's view at its full size (decision 0017, `views`), under the app's header. No view at
// the path is the router's not-found.
export function PluginScreen() {
  const { plugin, _splat } = useParams({ strict: false }) as { readonly plugin: string; readonly _splat?: string }
  const { actions } = usePlugins()
  const view = actions.viewAt(plugin, _splat ?? "")
  if (view === undefined) return null
  return (
    <main className="plugin-screen" aria-label={view.title} data-view={view.id}>
      <header className="plugin-screen-header">
        <Link to="/app">Back to chat</Link>
        <h1>{view.title}</h1>
        <div role="status" aria-label="Connection" aria-live="polite"><ConnectionPill /></div>
      </header>
      <PluginView view={view} />
    </main>
  )
}
