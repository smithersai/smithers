import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { Harness, LocalRepositoryConnector, Message, Repo, Suggestion } from "./state/AppState"

/*
 * The opening entry of a session: "Smithers initialized successfully", derived
 * (never stored) from what the host actually registered — the bootstrap
 * contract, the flow registry, the harness snapshot, the repositories — and
 * the one next step, selecting a repository. Same discipline as the derived
 * auth message in App.tsx: a projection of live collections, gone the moment
 * the state it reads changes.
 */

export const INIT_MESSAGE_ID = "init-state"
/** The one-word name, pinned: a live model once introduced itself as "Smith Smithers". */
export const SMITHERS_NAME = "Smithers"
/** The first line of every session: the agent names itself before it reports anything. */
export const INIT_GREETING = `${SMITHERS_NAME} here.`
export const INIT_TITLE = "Smithers initialized successfully"
export const SELECT_REPO_LABEL = "Select a repo"

/** How the session selects a repository: the native folder picker, or nothing to ask. */
export type RepoStep = "local" | "none"

export interface InitFacts {
  readonly bootstrap: AppBootstrap | undefined
  readonly flowCount: number
  readonly harnesses: ReadonlyArray<Harness>
  readonly connectors: ReadonlyArray<Pick<LocalRepositoryConnector, "name" | "branch">>
  readonly repos: ReadonlyArray<Pick<Repo, "name">>
  readonly repoStep: RepoStep
}

/** Structured fields used only by the derived opening-message projection. */
export interface InitMessage extends Message {
  readonly details: string
  readonly prompt?: string
}

const REPO_STEP_FLOW: Readonly<Record<Exclude<RepoStep, "none">, string>> = {
  local: "repo.open"
}

export const repoStep = (input: {
  readonly localPickerAvailable: boolean
  readonly connectors: ReadonlyArray<unknown>
  readonly repos: ReadonlyArray<unknown>
}): RepoStep => {
  /*
   * A repository already open or connected answers the step: the pill used
   * to stay on screen after the user had just selected one.
   */
  if (input.connectors.length > 0 || input.repos.length > 0) return "none"
  return input.localPickerAvailable ? "local" : "none"
}

/** The "Select a repo" pill for the step, or none. */
export const repoSuggestion = (step: RepoStep): ReadonlyArray<Suggestion> =>
  step === "none"
    ? []
    : [{ id: "select-repo", label: SELECT_REPO_LABEL, flow: REPO_STEP_FLOW[step], emphasis: "primary" }]

const harnessLine = (harness: Harness): string => {
  const account = harness.account?.email ?? harness.account?.label
  return `${harness.displayName} (${harness.status}${account === undefined ? "" : `, ${account}`})`
}

export const initMessage = (facts: InitFacts): InitMessage => {
  const { bootstrap } = facts
  const hostLine = bootstrap === undefined
    ? "Host: unknown"
    : `Host: ${bootstrap.host} (${bootstrap.version} ${bootstrap.buildSha.slice(0, 7)})${
      bootstrap.sandbox === null ? "" : `, sandbox ${bootstrap.sandbox.mode} on ${bootstrap.sandbox.platform}`
    }`
  const capabilities = bootstrap === undefined || bootstrap.capabilities.length === 0
    ? "none"
    : bootstrap.capabilities.join(", ")
  const harnesses = facts.harnesses.length === 0 ? "none detected" : facts.harnesses.map(harnessLine).join(", ")
  const repositories = [
    ...facts.repos.map((repo) => repo.name),
    ...facts.connectors.map((connector) => `${connector.name}${connector.branch === null ? "" : ` @ ${connector.branch}`}`)
  ]
  const detailLines = [
    `- ${hostLine}`,
    `- Capabilities: ${capabilities}`,
    `- Flows registered: ${facts.flowCount}`,
    `- Harnesses: ${harnesses}`,
    `- Repositories: ${repositories.length === 0 ? "none open" : repositories.join(", ")}`
  ]
  const prompt = facts.repoStep === "none" ? undefined : "Select a repo to get started."
  const lines = [`**${INIT_GREETING}**`, `**${INIT_TITLE}**`, "", ...detailLines]
  if (prompt !== undefined) lines.push("", prompt)
  return {
    id: INIT_MESSAGE_ID,
    role: "smithers",
    text: lines.join("\n"),
    details: detailLines.join("\n"),
    ...(prompt === undefined ? {} : { prompt }),
    status: "complete",
    ...(facts.repoStep === "none"
      ? {}
      : { action: { flow: REPO_STEP_FLOW[facts.repoStep], label: SELECT_REPO_LABEL } }),
    /* Before every stored row and the derived auth message (createdAt 0). */
    createdAt: -1,
    ordinal: 0
  }
}

/*
 * The identity answer (/smithers.who). Every sentence is a constant or a
 * fact the opening message already reads; nothing here is composed by a model.
 */

/** The helpers Smithers hands work to, each named only while its flow is registered on this host. */
export const SMITHERS_HELPERS: ReadonlyArray<{ readonly flow: string; readonly line: string }> = [
  { flow: "librarian.ask", line: "the Librarian (/librarian.ask) answers wiki and repository questions" },
  { flow: "flow.ask", line: "the Flows agent (/flow.ask) picks which flow to run" }
]

export interface IdentityFacts extends Pick<InitFacts, "bootstrap" | "harnesses" | "connectors" | "repos"> {
  /**
   * The `owner/name` the selection names (RepoContext.ts activeRepositoryId),
   * the same row the agent runtime context reads: a signed-out visitor at
   * /owner/name has a repository selected before any checkout is open.
   */
  readonly activeRepository: string | null
  /** Whether a flow is registered on this host right now; unregistered helpers are never named. */
  readonly registered: (flow: string) => boolean
}

const hostLabel = (bootstrap: AppBootstrap | undefined): string =>
  bootstrap === undefined ? "an unknown host" : bootstrap.host === "cloud" ? "the Smithers web app" : "the native Smithers app"

/**
 * The text /smithers.who renders: the name, the host, the repositories in
 * reach, and the helpers that exist here. Honest about absence: no harness,
 * no repository and no helper each read as such rather than as an invention.
 */
export const identityMessage = (facts: IdentityFacts): string => {
  /*
   * The selected repository leads: the visitor at /smithersai/smithers heard
   * "no repository is open yet" while the composer already named that head.
   * Open checkouts and connectors follow; a name appears once.
   */
  const inReach = [
    ...facts.repos.map((repo) => repo.name),
    ...facts.connectors.map((connector) => connector.name)
  ]
  const repositories = facts.activeRepository === null
    ? inReach
    : [facts.activeRepository, ...inReach.filter((name) => name !== facts.activeRepository)]
  const where = repositories.length === 0
    ? `I am ${SMITHERS_NAME}, the concierge of ${hostLabel(facts.bootstrap)}; no repository is open yet.`
    : `I am ${SMITHERS_NAME}, the concierge for ${repositories.join(", ")} in ${hostLabel(facts.bootstrap)}.`
  const harnesses = facts.harnesses.length === 0
    ? "No local harness is detected."
    : `Local harnesses: ${facts.harnesses.map(harnessLine).join(", ")}.`
  const helpers = SMITHERS_HELPERS.filter((helper) => facts.registered(helper.flow)).map((helper) => helper.line)
  const handoff = helpers.length === 0
    ? "I answer this chat myself; type / to see every flow I can run."
    : `I hand work to helpers: ${helpers.join("; ")}.`
  return [where, harnesses, handoff].join(" ")
}
