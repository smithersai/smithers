import { useLiveQuery } from "@tanstack/react-db"
import { Library } from "lucide-react"
import { useController } from "../ControllerContext"
import { SurfaceHeader } from "../SurfaceChrome"
import { loadedApp } from "./appSurface"
import { PluginGallery } from "./PluginGallery"
import { PluginRail } from "./PluginRail"
import { manifests } from "./catalog"

/*
 * The Library pane: the shelf beside the conversation.
 *
 * Every affordance here is one of the three doors onto the same flow — the
 * Install button runs `plugins.install`, which is what typing it does and
 * what the model asks for. The pane holds no state of its own: the installed
 * set is the session's, read live.
 */
export function PluginsSurface() {
  const controller = useController()
  const { data: sessionRows } = useLiveQuery((q) =>
    q.from({ session: controller.store.collections.sessions }).select(({ session }) => ({
      id: session.id,
      plugins: session.plugins
    }))
  )
  const installed = sessionRows[0]?.plugins ?? []
  /* What the shelf actually added here: the loader's own answer, recomputed each render. */
  const { surface, problem } = loadedApp(installed, (name) => controller.commands.find(name) !== undefined)
  return (
    <section className="plugins-surface embedded-pane" aria-label="Plugins on your workspace">
      <SurfaceHeader
        icon={<Library size={17} aria-hidden="true" />}
        title="Library"
        subtitle={`${installed.length} of ${manifests().length} installed`}
        closeCommand="chat"
        onClose={() => controller.runCommand("chat")}
      />
      <div className="plugins-content">
        {surface.rail.length === 0 ? null : (
          <PluginRail entries={surface.rail} onOpen={(flow) => controller.runCommand(flow)} />
        )}
        {problem === undefined ? null : <p className="plugin-problem" role="status">{problem}</p>}
        <PluginGallery
          installed={installed}
          onInstall={(id) => controller.runCommand("plugins.install", id)}
          onRemove={(id) => controller.runCommand("plugins.remove", id)}
        />
      </div>
    </section>
  )
}
