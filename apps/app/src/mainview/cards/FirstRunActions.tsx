import "./FirstRunActions.css"
import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "../ControllerContext"
import { runtimeFlowName } from "../flows/FlowName"
import { flowAction } from "../flows/FlowAction"
import { recommendedNames, visible, type CatalogItem, type CommandState } from "../flows/registry"
import type { RunCommand } from "./CardFamily"

export function firstRunGroups(commands: readonly CatalogItem[], state: CommandState) {
  const recommended = recommendedNames(state)
  const rank = (name: string) => { const index = recommended.indexOf(name); return index < 0 ? Infinity : index }
  const groups = new Map<string, CatalogItem[]>()
  for (const flow of visible(commands)) {
    const namespace = flow.name.split(".")[0]!
    const group = groups.get(namespace) ?? []
    group.push(flow)
    groups.set(namespace, group)
  }
  return [...groups].map(([namespace, flows]) => ({ namespace,
    flows: flows.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
  })).sort((a, b) => rank(a.flows[0]!.name) - rank(b.flows[0]!.name) || a.namespace.localeCompare(b.namespace))
}

export function FirstRunActionsCard({ commands, state, onRunCommand, onDismiss }: {
  commands: readonly CatalogItem[]
  state: CommandState
  onRunCommand: RunCommand
  onDismiss: () => void
}) {
  const run: RunCommand = (flow, args) => { onDismiss(); return onRunCommand(flow, args) }
  return <section className="first-run-actions" data-testid="first-run-actions" aria-label="Recommended actions">
    <header><h2>Recommended actions</h2><button type="button" aria-label="Dismiss recommended actions" onClick={onDismiss}>×</button></header>
    {firstRunGroups(commands, state).map(group => <section key={group.namespace} aria-label={group.namespace}>
      <h3>{group.namespace}</h3>
      {group.flows.map(flow => <button type="button" key={flow.name} {...flowAction(run, runtimeFlowName(flow.name))} title={flow.summary}>{flow.name}</button>)}
    </section>)}
  </section>
}

/** Live session projection; no card row or model request. */
export function FirstRunActions() {
  const controller = useController()
  const { collections } = controller.store
  const { data: sessions } = useLiveQuery(q => q.from({ session: collections.sessions }).select(({ session }) => ({
    dismissed: session.firstRunDismissed, surface: session.surface, phase: session.phase, plugins: session.plugins,
  })))
  const { data: identities } = useLiveQuery(collections.identitySessions)
  const { data: connectors } = useLiveQuery(collections.connectors)
  const { data: repos } = useLiveQuery(collections.repos)
  // Repository flow leaves change with this collection.
  useLiveQuery(collections.repositoryFlows)
  const session = sessions[0]
  if (session?.dismissed ?? controller.store.session().firstRunDismissed) return null
  const identity = identities[0]
  return <FirstRunActionsCard commands={controller.commands.all()} state={{
    surface: session?.surface ?? "chat", typing: session?.phase === "responding", plugins: session?.plugins,
    signedOut: identity?.state === "signed-out", admin: identity?.admin === true,
    hasConnectors: identity?.state === "signed-in" || connectors.length > 0, hasOpenRepos: repos.length > 0,
  }} onRunCommand={controller.runCommand} onDismiss={() => {
    controller.store.dispatch({ type: "first-run.dismissed", actor: "user" })
  }} />
}
