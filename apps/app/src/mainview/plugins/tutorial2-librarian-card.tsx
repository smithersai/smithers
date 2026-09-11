import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "../ControllerContext"
import { PluginGallery } from "./PluginGallery"
import { PluginRail } from "./PluginRail"
import { loadedApp } from "./appSurface"

/** Same gallery and installed collection as the Library, embedded for either actor. */
export function LibrarianLibraryCard({ tutorial = false }: { readonly tutorial?: boolean }) {
  const controller = useController()
  const { data } = useLiveQuery(q => q.from({ session: controller.store.collections.sessions })
    .select(({ session }) => ({ plugins: session.plugins })))
  const installed = data[0]?.plugins ?? []
  const { surface, problem } = loadedApp(installed, name => controller.commands.find(name) !== undefined)
  return <div className="plugins-content">
    {surface.rail.length > 0 && <PluginRail entries={surface.rail} onOpen={flow => controller.runCommand(flow)} />}
    {problem !== undefined && <p role="status">{problem}</p>}
    <PluginGallery installed={installed} asked={undefined}
      onInstall={id => controller.runCommand("plugins.install", id)}
      onRemove={tutorial ? undefined : id => controller.runCommand("plugins.remove", id)} />
  </div>
}
