import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "../ControllerContext"
import { flowAction } from "../flows/FlowAction"
import { runtimeFlowName } from "../flows/FlowName"
import { visible, type CatalogItem } from "../flows/registry"
import { activeRepositoryId } from "../state/RepoContext"
import type { RunCommand } from "./CardFamily"
import "./SetupChecklist.css"

/*
 * The start-page checklist: what part of setup is done, and the one flow that
 * advances each remaining step. Completion is derived from live state — a step
 * checks itself off when the world says it happened, never when its button was
 * clicked. The list hides itself once every step is complete.
 */
export interface SetupProgress {
  readonly signedIn: boolean
  readonly hasRepo: boolean
  readonly hasSetup: boolean
}

interface SetupStep {
  readonly id: string
  readonly label: string
  /** The first of these flows registered on this host performs the step. */
  readonly flows: ReadonlyArray<string>
  readonly done: (state: SetupProgress) => boolean
}

export const SETUP_STEPS: ReadonlyArray<SetupStep> = [
  { id: "connect-github", label: "Connect GitHub", flows: ["auth.sign-in"], done: state => state.signedIn },
  { id: "add-repository", label: "Add a repository", flows: ["repos.import", "repo.open"], done: state => state.hasRepo },
  { id: "set-up-job", label: "Set up a job", flows: ["issues.setup"], done: state => state.hasSetup },
]

export interface ResolvedStep {
  readonly id: string
  readonly label: string
  readonly complete: boolean
  /** Undefined when no host flow can perform the step: the row is a fact, not a button. */
  readonly flow?: string
  readonly args?: string
}

export function resolveSteps(commands: readonly CatalogItem[], state: SetupProgress, repo?: string): ReadonlyArray<ResolvedStep> {
  const catalog = visible(commands)
  return SETUP_STEPS.map(step => {
    const flow = step.flows.find(name => catalog.some(item => item.name === name))
    return { id: step.id, label: step.label, complete: step.done(state), flow, args: flow === "issues.setup" ? repo : undefined }
  })
}

export function SetupChecklistCard({ steps, onRunCommand }: {
  steps: ReadonlyArray<ResolvedStep>
  onRunCommand: RunCommand
}) {
  const done = steps.filter(step => step.complete).length
  return <section className="setup-checklist" data-testid="setup-checklist" aria-label="Set up Smithers">
    <header><h2>Set up Smithers</h2><span className="setup-checklist-count">{done} of {steps.length}</span></header>
    <progress value={done} max={steps.length}>{done} of {steps.length}</progress>
    <ol>
      {steps.map(step => <li key={step.id} data-complete={step.complete || undefined}>
        {step.complete ? <><span aria-hidden="true">✓</span>{step.label}</> :
          step.flow !== undefined ?
            <button type="button" {...flowAction(onRunCommand, runtimeFlowName(step.flow), step.args)}>{step.label}</button> :
            step.label}
      </li>)}
    </ol>
  </section>
}

/** Live session projection; no card row or model request. */
export function SetupChecklist({ commands }: { commands?: readonly CatalogItem[] }) {
  const controller = useController()
  const { collections } = controller.store
  const { data: sessions } = useLiveQuery(q => q.from({ session: collections.sessions }).select(({ session }) => ({
    repositoryEntry: session.repositoryEntry,
  })))
  const { data: identities } = useLiveQuery(collections.identitySessions)
  const { data: repos } = useLiveQuery(collections.repos)
  const { data: repositories } = useLiveQuery(collections.repositories)
  const { data: cards } = useLiveQuery(collections.cards)
  const steps = resolveSteps(commands ?? controller.commands.all(), {
    signedIn: identities[0]?.state === "signed-in",
    hasRepo: repos.length > 0 || repositories.some(row => row.catalog !== true),
    hasSetup: cards.some(card => card.kind === "repository-setup"),
  }, sessions[0]?.repositoryEntry?.repo ?? activeRepositoryId(controller.store) ?? undefined)
  if (steps.every(step => step.complete)) return null
  return <SetupChecklistCard steps={steps} onRunCommand={controller.runCommand} />
}
