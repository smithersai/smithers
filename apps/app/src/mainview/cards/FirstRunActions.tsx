import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "../ControllerContext"
import { FirstSightHint } from "../FirstSightHint"
import { flowAction } from "../flows/FlowAction"
import { runtimeFlowName } from "../flows/FlowName"
import { recommendedNames,unmetRequirements,visible,type CatalogItem,type CommandState } from "../flows/registry"
import { activeCatalogRepositoryId } from "../state/RepoContext"
import type { RunCommand } from "./CardFamily"
import "./FirstRunActions.css"

const namespaceTitles: Readonly<Record<string, string>> = {
  auth: "Account", repo: "Repositories", issues: "Issues", prs: "Changes", change: "Changes",
  wiki: "Wiki", chat: "Chat", flow: "Flows", flows: "Flows", secrets: "Secrets",
  plugins: "Plugins", admin: "Admin", connector: "Connectors", connect: "Connectors",
}
const namespaceTitle = (namespace: string) =>
  namespaceTitles[namespace] ?? namespace.charAt(0).toUpperCase() + namespace.slice(1)

export function firstRunGroups(commands: readonly CatalogItem[], state: CommandState) {
  const recommended = recommendedNames(state)
  const rank = (name: string) => { const index = recommended.indexOf(name); return index < 0 ? Infinity : index }
  const groups = new Map<string, CatalogItem[]>()
  for (const flow of visible(commands)) {
    // The live catalog already gates runtime/runtimeAny and admin/plugin registration.
    if (unmetRequirements(flow, state).length > 0) continue
    const namespace = flow.name.split(".")[0]!
    if (namespace === "system") continue
    const group = groups.get(namespace) ?? []
    group.push(flow)
    groups.set(namespace, group)
  }
  return [...groups].map(([namespace, flows]) => ({ namespace,
    flows: flows.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
  })).sort((a, b) => rank(a.flows[0]!.name) - rank(b.flows[0]!.name) || a.namespace.localeCompare(b.namespace))
}

export function FirstRunActionsCard({ commands, state, onRunCommand: dispatchFlow, onDismiss }: {
  commands: readonly CatalogItem[]
  state: CommandState
  onRunCommand: RunCommand
  onDismiss: () => void
}) {
  const recommended = recommendedNames(state)
  const onRunCommand: RunCommand = (flow, args) => {
    onDismiss()
    if (flow !== "app.first-run.dismiss") dispatchFlow(flow, args)
  }
  return <section className="first-run-actions" data-testid="first-run-actions" aria-label="Recommended actions">
    <header><h2>Recommended actions</h2><button type="button" aria-label="Dismiss recommended actions" {...flowAction(onRunCommand, "app.first-run.dismiss")}>×</button></header>
    {firstRunGroups(commands, state).map(group => <section key={group.namespace} aria-label={namespaceTitle(group.namespace)}>
      <h3>{namespaceTitle(group.namespace)}</h3>
      {group.flows.map(flow => <button type="button" key={flow.name} {...flowAction(onRunCommand, runtimeFlowName(flow.name))} className={recommended.includes(flow.name) ? "emphasis" : undefined}>{flow.summary}</button>)}
    </section>)}
  </section>
}

/** Live session projection; no card row or model request. */
export function FirstRunActions({ commands }: { commands?: readonly CatalogItem[] }) {
  const controller = useController()
  const { collections } = controller.store
  const { data: sessions } = useLiveQuery(q => q.from({ session: collections.sessions }).select(({ session }) => ({
    dismissed: session.firstRunDismissed, surface: session.surface, phase: session.phase, plugins: session.plugins, activeRepoKey: session.activeRepoKey,
  })))
  const { data: identities } = useLiveQuery(collections.identitySessions)
  const { data: connectors } = useLiveQuery(collections.connectors)
  const { data: repos } = useLiveQuery(collections.repos)
  useLiveQuery(collections.repositories)
  // Repository flow leaves change with this collection.
  useLiveQuery(collections.repositoryFlows)
  const session = sessions[0]
  if (session?.dismissed ?? controller.store.session().firstRunDismissed) return null
  const identity = identities[0]
  return <FirstSightHint id="first-run" content="Choose an action to begin."><FirstRunActionsCard commands={commands ?? controller.commands.all()} state={{
    surface: session?.surface ?? "chat", typing: session?.phase === "responding", plugins: session?.plugins,
    signedOut: identity?.state === "signed-out", admin: identity?.admin === true,
    hasConnectors: identity?.state === "signed-in" || connectors.length > 0, hasOpenRepos: repos.length > 0,
    publicRepo: activeCatalogRepositoryId(controller.store) !== null,
  }} onRunCommand={controller.runCommand} onDismiss={() => {
    controller.dismissFirstRun()
  }} /></FirstSightHint>
}
