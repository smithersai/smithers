import type { Host } from "@smthrs/plugin"
import { type ComponentType, Suspense, use } from "react"
import { Boundary } from "./Boundary"
import { usePlugins } from "./PluginsContext"

// A `component` render of a built-in plugin: its chunk and its tab load on first use, then the named export renders
// with the tab, `{ queries, actions }`, and on a repository's page that repository (`Host.Rendered`). Nothing else
// reaches it.

interface Props {
  readonly plugin: string
  readonly name: string
  readonly repository?: Host.Repository | undefined
}

function Loaded({ plugin, name, repository }: Props) {
  const { actions } = usePlugins()
  const components = use(actions.components(plugin))
  const tab = use(actions.tab(plugin))
  const Rendered = components[name] as ComponentType<Host.Rendered<unknown>> | undefined
  if (Rendered === undefined) throw new Error(`${plugin} exports no ${name}`)
  return <Rendered tab={tab} repository={repository} />
}

export function Contributed({ plugin, name, repository }: Props) {
  const { actions } = usePlugins()
  return (
    <Boundary plugin={plugin} report={(error) => actions.failed(plugin, error)}>
      <Suspense fallback={null}>
        <Loaded plugin={plugin} name={name} repository={repository} />
      </Suspense>
    </Boundary>
  )
}
