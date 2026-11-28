import type { Host } from "@smthrs/plugin"
import { type ComponentType, lazy, type PropsWithChildren, Suspense, useMemo } from "react"
import { Boundary } from "./Boundary"
import { usePlugins } from "./PluginsContext"

// An active plugin owns its tab and component chunk. React keeps one lazy component for this export
// across suspended renders. The host shares both resources with the plugin's other contributions.
interface Props {
  readonly plugin: string
  readonly name: string
  readonly slot?: string
  readonly repository?: Host.Repository | undefined
}

function Contribution({ plugin, name, repository, slot }: Props) {
  const { actions } = usePlugins()
  const Loaded = useMemo(() => lazy(async () => {
    const components = await actions.components(plugin)
    const tab = await actions.tab(plugin)
    const Frame = (slot === undefined ? undefined : await actions.slotFrame?.(plugin, slot)) as ComponentType<PropsWithChildren> | undefined
    const Rendered = components[name] as ComponentType<Host.Rendered<unknown>> | undefined
    if (Rendered === undefined) throw new Error(`${plugin} exports no ${name}`)
    return { default: (props: Pick<Props, "repository">) => {
      const content = <Rendered tab={tab} repository={props.repository} />
      return Frame === undefined ? content : <Frame>{content}</Frame>
    } }
  }), [actions, plugin, name, slot])

  return <Suspense fallback={null}><Loaded repository={repository} /></Suspense>
}

export function Contributed(props: Props) {
  const { actions } = usePlugins()
  return (
    <Boundary plugin={props.plugin} report={(error) => actions.failed(props.plugin, error)}>
      <Contribution {...props} />
    </Boundary>
  )
}
