import { RepositoryJobSchema, type RepositoryJob, type RepositorySetup } from "@smthrs/rpc/RepositorySetup"
import type { Card } from "./AppState"

/** A saved draft is not an enabled repository responsibility. */
export const repositoryCiConfigured = (cards: Iterable<Card>, repo: string, owner: string | null): boolean =>
  [...cards].some(card => card.kind === "repository-setup" && card.payload.job === "ci" && card.payload.repo === repo
    && card.payload.owner === owner && card.payload.active?.enabled === true)

/**
 * The Smithers Cloud workspace this repository's reviewed jobs run on, as
 * their own setups recorded it. Two setups naming different workspaces name
 * none: nothing here picks between them.
 */
export const repositoryJobWorkspace = (cards: Iterable<Card>, repo: string, owner: string | null): string | undefined => {
  const recorded = new Set([...cards].flatMap(card => card.kind === "repository-setup" && card.payload.repo === repo
    && card.payload.owner === owner && card.payload.workspaceId !== undefined ? [card.payload.workspaceId] : []))
  return recorded.size === 1 ? [...recorded][0] : undefined
}

/**
 * A job's registered state, in the setup card's own words. Undefined until the
 * host has answered what is registered: an unread registration is not "Off".
 *
 * A registration the card is HOLDING is an answer the host already gave, so it
 * is read whatever the recovery is doing now. Boot re-reads every setup card
 * (controller/repositorySetup.ts resumeRepositorySetups), and that re-read
 * parks `registrationState` at "unknown" until it lands and at "unavailable"
 * when it fails — which used to blank the state of a job that is registered,
 * so one census read "Handle issues · Paused" beside a bare "Build a feature"
 * whose registration was enabled at revision 57. Only a card with no
 * registration at all waits for the answer.
 */
export const repositoryJobState = (setup: Pick<RepositorySetup, "revision" | "active" | "recovery">): string | undefined =>
  setup.active?.enabled ? setup.active.revision === setup.revision ? "Enabled" : "Enabled · draft changes"
    : setup.active ? "Paused"
    : setup.recovery !== undefined && setup.recovery.registrationState !== "known" ? undefined
    : setup.recovery?.trialRegistration ? setup.recovery.trialRegistration.enabled ? "Trial" : "Paused"
    : "Off"

/** {@link repositoryJobState} for every job this account configured on one repository. */
export const repositoryJobStates = (cards: Iterable<Card>, repo: string, owner: string | null): Partial<Record<RepositoryJob, string>> => {
  const states: Partial<Record<RepositoryJob, string>> = {}
  for (const card of cards) {
    if (card.kind !== "repository-setup" || card.payload.repo !== repo || card.payload.owner !== owner) continue
    const state = repositoryJobState(card.payload)
    if (state !== undefined) states[card.payload.job] = state
  }
  return states
}

/** The job a `<job>.setup` flow configures. */
export const repositoryJobOf = (flow: string): RepositoryJob | undefined => {
  const parsed = RepositoryJobSchema.safeParse(flow.replace(/\.setup$/, ""))
  return parsed.success ? parsed.data : undefined
}
