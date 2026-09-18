import type { RepositoryJob } from "@smthrs/rpc/RepositorySetup"
import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "../ControllerContext"
import { flowAction } from "../flows/FlowAction"
import { runtimeFlowName } from "../flows/FlowName"
import { unmetRequirements,visible,type CatalogItem,type CommandState } from "../flows/registry"
import { activeCatalogRepositoryId, activeRepositoryId } from "../state/RepoContext"
import { repositoryJobOf, repositoryJobStates } from "../state/RepositoryJobs"
import type { RunCommand } from "./CardFamily"
import "./FirstRunActions.css"

/** Recommendation policy projects real commands; the full catalog stays in Chat. */
export const FIRST_RUN_JOBS = ["issues.setup", "review.setup", "ci.setup", "feature.setup", "chores.setup"] as const

export function firstRunGroups(commands: readonly CatalogItem[], state: CommandState) {
  const catalog = visible(commands)
  const flows = FIRST_RUN_JOBS.flatMap(name => {
    const flow = catalog.find(item => item.name === name)
    return flow && unmetRequirements(flow, state).length === 0 ? [flow] : []
  })
  return flows.length ? [{ namespace: "repository", flows }] : []
}

/** A configured job reads its state; a job with none is still its own name. */
const jobState = (states: Partial<Record<RepositoryJob, string>> | undefined, flow: string) => {
  const job = repositoryJobOf(flow)
  const state = job === undefined ? undefined : states?.[job]
  return state === undefined ? null : ` · ${state}`
}

export function FirstRunActionsCard({ commands, state, repo, jobStates, onRunCommand: dispatchFlow, onDismiss }: {
  commands: readonly CatalogItem[]
  state: CommandState
  repo?: string
  jobStates?: Partial<Record<RepositoryJob, string>>
  onRunCommand: RunCommand
  onDismiss: () => void
}) {
  // Every job stays one button away: only the dismissal closes the card.
  const onRunCommand: RunCommand = (flow, args) => {
    if (flow === "app.first-run.dismiss") return onDismiss()
    dispatchFlow(flow, args)
  }
  return <section className="first-run-actions" data-testid="first-run-actions" aria-label="Recommended actions">
    <header><h2>Recommended actions</h2><button type="button" aria-label="Dismiss recommended actions" {...flowAction(onRunCommand, "app.first-run.dismiss")}>×</button></header>
    {firstRunGroups(commands, state).map(group => <section key={group.namespace} aria-label="Repository jobs">
      {group.flows.map(flow => <button type="button" key={flow.name} {...flowAction(onRunCommand, runtimeFlowName(flow.name), repo)}>{flow.summary}{jobState(jobStates, flow.name)}</button>)}
    </section>)}
  </section>
}

/** Live session projection; no card row or model request. */
export function FirstRunActions({ commands }: { commands?: readonly CatalogItem[] }) {
  const controller = useController()
  const { collections } = controller.store
  const { data: sessions } = useLiveQuery(q => q.from({ session: collections.sessions }).select(({ session }) => ({
    dismissed: session.firstRunDismissed, surface: session.surface, phase: session.phase, plugins: session.plugins, activeRepoKey: session.activeRepoKey, repositoryEntry: session.repositoryEntry,
  })))
  const { data: identities } = useLiveQuery(collections.identitySessions)
  const { data: connectors } = useLiveQuery(collections.connectors)
  const { data: repos } = useLiveQuery(collections.repos)
  const { data: cards } = useLiveQuery(collections.cards)
  useLiveQuery(collections.repositories)
  // Repository flow leaves change with this collection.
  useLiveQuery(collections.repositoryFlows)
  const session = sessions[0]
  if (session?.dismissed ?? controller.store.session().firstRunDismissed) return null
  const identity = identities[0]
  const repo = session?.repositoryEntry?.repo ?? activeRepositoryId(controller.store) ?? undefined
  const owner = identity?.accountOwnerLogin !== undefined ? identity.accountOwnerLogin : identity?.state === "signed-in" ? identity.login : null
  return <FirstRunActionsCard commands={commands ?? controller.commands.all()}
    repo={repo} jobStates={repo === undefined ? undefined : repositoryJobStates(cards, repo, owner)} state={{
    surface: session?.surface ?? "chat", typing: session?.phase === "responding", plugins: session?.plugins,
    signedOut: identity?.state === "signed-out", admin: identity?.admin === true,
    hasConnectors: identity?.state === "signed-in" || connectors.length > 0, hasOpenRepos: repos.length > 0,
    publicRepo: activeCatalogRepositoryId(controller.store) !== null,
  }} onRunCommand={controller.runCommand} onDismiss={() => {
    controller.dismissFirstRun()
  }} />
}
