import { type ComponentType, Suspense, use } from "react"
import { Boundary } from "./Boundary"
import { usePlugins } from "./PluginsContext"

// A `component` render of a built-in plugin: its chunk and its tab load on first use, then the named export renders
// with the tab, `{ queries, actions }`. Nothing else reaches it.

function Loaded({ plugin, name }: { readonly plugin: string; readonly name: string }) {
  const { actions } = usePlugins()
  const components = use(actions.components(plugin))
  const tab = use(actions.tab(plugin))
  const Rendered = components[name] as ComponentType<{ readonly tab: unknown }> | undefined
  if (Rendered === undefined) throw new Error(`${plugin} exports no ${name}`)
  return <Rendered tab={tab} />
}

export function Contributed({ plugin, name }: { readonly plugin: string; readonly name: string }) {
  const { actions } = usePlugins()
  return (
    <Boundary plugin={plugin} report={(error) => actions.failed(plugin, error)}>
      <Suspense fallback={null}>
        <Loaded plugin={plugin} name={name} />
      </Suspense>
    </Boundary>
  )
}
