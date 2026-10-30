import { useParams } from "@tanstack/react-router"
import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { usePlugins } from "../../plugins/components/PluginsContext"
import { PluginView } from "./PluginView"
import "../repo/repo-screen.css"
import "./plugin-screen.css"

// /<owner>/<repo>/-/<plugin>/<path>: a plugin's `repository` view (decision 0126 §8) under the repository's header,
// whose `repo.tabs` slot holds the plugin's tab. The view gets the repository it shows on. No view at the path is the
// router's not-found.
export function RepoPluginScreen() {
  const { owner, repo, plugin, _splat } = useParams({ strict: false }) as {
    readonly owner: string
    readonly repo: string
    readonly plugin: string
    readonly _splat?: string
  }
  const { actions } = usePlugins()
  const view = actions.viewAt(plugin, _splat ?? "", "repository")
  if (view === undefined) return null
  return (
    <main className="repo-screen" aria-label={view.title} data-view={view.id}>
      <RepoHeader />
      <PluginView view={view} repository={{ owner, name: repo }} />
    </main>
  )
}
