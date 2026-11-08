import { statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join } from "node:path"
import { sessionDirOf } from "./settings.ts"
import { redact } from "./redact.ts"

/** Production acceptance needs real success in both browser projects, even when a run filters one out. */
export const SHIP_TARGETS = ["deployment", "webkit"] as const

type Prerequisite = { readonly name: string; readonly kind: "value" | "repository" | "scratch" | "mirror" | "signIn" | "privateFile" | "enabled" }
type Feature = {
  readonly id: string
  readonly feature: string
  readonly specs: ReadonlyArray<string>
  readonly prerequisites: ReadonlyArray<Prerequisite>
}

const model: Prerequisite = { name: "E2E_PERSONAL_MODEL_KEY", kind: "value" }
const issues: Prerequisite = { name: "E2E_ISSUES_REPOSITORY", kind: "scratch" }
const stack: Prerequisite = { name: "E2E_STACK_REPOSITORY", kind: "scratch" }
const logs: ReadonlyArray<Prerequisite> = [
  { name: "CLOUDFLARE_API_TOKEN", kind: "value" },
  { name: "CLOUDFLARE_ACCOUNT_ID", kind: "value" },
]

/**
 * The one ship feature/spec contract, from docs/rulings.md SCOPE-6 and SCOPE-7. Every listed spec must execute
 * successfully on every SHIP_TARGETS project. A dev-only journey in one of these specs is a ship blocker until
 * there is real deployment evidence; ordinary developer runs still permit its declared skip.
 */
export const SHIP_FEATURES: ReadonlyArray<Feature> = [
  { id: "SCOPE-6/1", feature: "Flows and the agent", specs: ["agent.spec.ts", "personal-model.spec.ts"], prerequisites: [model, ...logs] },
  { id: "SCOPE-6/2", feature: "Clone and view a repository", specs: ["repo-clone.spec.ts", "repo-browse.spec.ts"], prerequisites: [model, { name: "E2E_ABSENT_REPOSITORY", kind: "repository" }] },
  { id: "SCOPE-6/3", feature: "Forms and generated views", specs: ["forms.spec.ts", "generated-view.spec.ts"], prerequisites: [model] },
  { id: "SCOPE-6/3b", feature: "Agent evals", specs: ["agent-deployment.spec.ts"], prerequisites: [model, stack] },
  { id: "SCOPE-6/4", feature: "Agent opens files and highlights code", specs: ["files.spec.ts"], prerequisites: [model] },
  { id: "SCOPE-6/5", feature: "Durable branch sandboxes", specs: ["sandbox-lifecycle.spec.ts"], prerequisites: [] },
  { id: "SCOPE-6/6", feature: "Secrets egress", specs: ["secrets-egress.spec.ts"], prerequisites: [
    ...logs, { name: "E2E_SECRETS_EGRESS", kind: "enabled" },
    { name: "E2E_SECRETS_REPOSITORY", kind: "scratch" }, { name: "E2E_SECRETS_BRANCH", kind: "value" },
  ] },
  { id: "SCOPE-6/7", feature: "Agent uses the branch sandbox", specs: ["sandbox-tools.spec.ts"], prerequisites: [model] },
  { id: "SCOPE-6/8", feature: "Notifications and status from the old app", specs: ["notifications.spec.ts", "status.spec.ts"], prerequisites: [model, { name: "E2E_GITHUB_WEBHOOK_SECRET", kind: "value" }, { name: "E2E_SYNCED_REPOSITORY", kind: "repository" }] },
  { id: "SCOPE-6/designs", feature: "Sign-in and roles", specs: ["sign-in.spec.ts", "who-may-ask.spec.ts"], prerequisites: [{ name: "E2E_GITHUB_PROFILE or stored session.json", kind: "signIn" }] },
  { id: "SCOPE-7/commands", feature: "Slash commands", specs: ["slash-commands.spec.ts"], prerequisites: [model] },
  { id: "SCOPE-7/navigate", feature: "Agent and person navigate", specs: ["navigate.spec.ts"], prerequisites: [model] },
  { id: "SCOPE-7/web", feature: "Web pages in chat and a new tab", specs: ["web-page.spec.ts"], prerequisites: [model] },
  { id: "SCOPE-7/terminal", feature: "Branch conversation and terminal", specs: ["branch-workspace.spec.ts"], prerequisites: [model] },
  { id: "SCOPE-7/messages", feature: "Message controls", specs: ["message-controls.spec.ts"], prerequisites: [model] },
  { id: "SCOPE-7/repository", feature: "Repository view extras", specs: ["repo-extras.spec.ts"], prerequisites: [] },
  { id: "SCOPE-7/pulls", feature: "Pull request list", specs: ["vibelang-items.spec.ts", "list-search-sort.spec.ts"], prerequisites: [] },
  { id: "SCOPE-7/git", feature: "Issues, TODOs, pull requests, publish and resync", specs: ["issues.spec.ts", "todos.spec.ts", "branch-publish.spec.ts", "agent-runner.spec.ts"], prerequisites: [
    model, issues, stack,
    { name: "E2E_FACTORY_REPOSITORY", kind: "scratch" },
    { name: "E2E_RUNNER_MIRROR", kind: "mirror" },
    { name: "GITHUB_APP_ID", kind: "value" },
    { name: "GITHUB_APP_PRIVATE_KEY", kind: "value" },
  ] },
  { id: "SCOPE-7/home", feature: "Repository home", specs: ["home-effect.spec.ts"], prerequisites: [] },
  { id: "SCOPE-7/flows", feature: "Create, debug, stop and retry flows", specs: ["flows.spec.ts", "run-records.spec.ts", "undispatched-steps.spec.ts"], prerequisites: [model, { name: "E2E_FAILED_RUN", kind: "value" }] },
  { id: "SCOPE-7/sharing", feature: "Multiplayer branch sharing", specs: ["branch-sharing.spec.ts"], prerequisites: [
    { name: "E2E_TEAMMATE_LOGIN", kind: "value" }, { name: "E2E_TEAMMATE_SESSION", kind: "privateFile" },
    { name: "E2E_GUEST_LOGIN", kind: "value" }, { name: "E2E_GUEST_SESSION", kind: "privateFile" },
  ] },
  { id: "SCOPE-7/triage", feature: "Custom issue triage", specs: ["issues.spec.ts"], prerequisites: [issues] },
  { id: "SCOPE-7/jev", feature: "Agent uses Jev", specs: ["jev.spec.ts"], prerequisites: [model] },
  { id: "SCOPE-7/status", feature: "Agent needs help", specs: ["status.spec.ts"], prerequisites: [model] },
]

type Env = Readonly<Record<string, string | undefined>>

const fixtureExists = (path: string, kind: "file" | "directory" | "privateFile") => {
  try {
    const stat = statSync(path)
    return kind === "directory" ? stat.isDirectory() : stat.isFile() && (kind !== "privateFile" || (stat.mode & 0o077) === 0)
  } catch {
    return false
  }
}

/** Opt in explicitly; a typo must never silently turn ship acceptance off. Values are never included in errors. */
export const shipAcceptance = (env: Env): boolean => {
  const value = env.E2E_SHIP_ACCEPTANCE
  if (value === undefined || value === "" || value === "0") return false
  if (value === "1") return true
  throw new Error("E2E_SHIP_ACCEPTANCE must be 1 (ship acceptance) or 0 (developer run)")
}

/** The manifest's features covered by a file; accepts absolute Playwright paths on either host platform. */
export const shipFeaturesOf = (file: string) => {
  const spec = file.split(/[\\/]/).at(-1)!
  return SHIP_FEATURES.filter((feature) => feature.specs.includes(spec))
}

/** Check credentials and fixture names/paths before taking resource leases or making any network request. */
export const assertShipPrerequisites = (env: Env, args: ReadonlyArray<string> = []): void => {
  if (!shipAcceptance(env)) return
  if (args.length > 0) throw new Error("Ship acceptance runs the full suite; omit spec filters and Playwright options")
  const missing = new Map<string, string>()
  for (const feature of SHIP_FEATURES) {
    for (const prerequisite of feature.prerequisites) {
      const value = env[prerequisite.name]?.trim() ?? ""
      let valid = value !== ""
      if (prerequisite.kind === "enabled") valid = env[prerequisite.name] === "true"
      if (prerequisite.kind === "repository" || prerequisite.kind === "scratch") {
        valid = /^[\w.-]+\/[\w.-]+$/.test(value) && (prerequisite.kind !== "scratch" || !/^smithersai\//i.test(value))
      }
      if (prerequisite.kind === "mirror") valid = value !== "" && fixtureExists(join(value, ".jj"), "directory")
      if (prerequisite.kind === "privateFile") valid = isAbsolute(value) && fixtureExists(value, "privateFile")
      if (prerequisite.kind === "signIn") {
        const url = env.E2E_PROD_URL ?? env.BASE_URL
        const profile = env.E2E_GITHUB_PROFILE ?? join(homedir(), ".multi-e2e-profile")
        valid = fixtureExists(profile, "directory") || (env.E2E_FRESH_SIGN_IN !== "1" && url !== undefined && fixtureExists(join(sessionDirOf(url, env), "session.json"), "file"))
      }
      if (!valid) missing.set(prerequisite.name, `${prerequisite.name} (${prerequisite.kind}; ${feature.id}: ${feature.feature})`)
    }
  }
  if (missing.size > 0) throw new Error(`Ship acceptance missing prerequisites:\n${[...missing.values()].map((name) => `  - ${name}`).join("\n")}`)
}

/** A collected test's identity, independent of its execution result or a browser's skip annotations. */
export type ShipTest = {
  readonly file: string
  readonly title: string
  readonly project?: string
  readonly name?: string
  readonly line?: number
  readonly column?: number
}

export const shipTestIdentity = (test: ShipTest) =>
  JSON.stringify([basename(test.file), test.name ?? test.title, test.project ?? "", test.line ?? 0, test.column ?? 0])

type ListedSuite = {
  readonly suites?: ReadonlyArray<ListedSuite>
  readonly specs?: ReadonlyArray<{
    readonly file: string
    readonly title: string
    readonly line: number
    readonly column: number
    readonly tests: ReadonlyArray<{ readonly projectName: string }>
  }>
}

/** The unfiltered --list JSON report, collected by prod.mjs before launching the real run. No cookies or results. */
export const shipInventory = (report: { readonly suites: ReadonlyArray<ListedSuite> }): ReadonlyArray<ShipTest> => {
  const visit = (suite: ListedSuite): ReadonlyArray<ShipTest> => [
    ...(suite.specs ?? []).flatMap((spec) => spec.tests.map((test) => ({ file: spec.file, title: spec.title, line: spec.line, column: spec.column, project: test.projectName }))),
    ...(suite.suites ?? []).flatMap(visit),
  ]
  return report.suites.flatMap(visit).filter((test) => shipFeaturesOf(test.file).length > 0)
}

type Grep = RegExp | ReadonlyArray<RegExp>
type Selection = {
  readonly grep: Grep
  readonly grepInvert: Grep | null
  readonly shard: unknown
  readonly projects: ReadonlyArray<{ readonly grep: Grep; readonly grepInvert: Grep | null; readonly repeatEach: number }>
}

/** Config-level filters must not hide journeys from both discovery and execution. */
export const assertShipSelection = (config: Selection): void => {
  if (String(config.grep) !== "/.*/" || config.grepInvert !== null || config.shard !== null ||
    config.projects.some((project) => String(project.grep) !== "/.*/" || project.grepInvert !== null || project.repeatEach !== 1)) {
    throw new Error("Ship acceptance requires unfiltered, unsharded projects with repeatEach=1")
  }
}

/** Collection errors remain diagnosable, without header values or credentials supplied through the environment. */
export const shipListingDiagnostics = (stderr: string, stdout: string, env: Env): string => {
  let message = stderr
  try {
    const report = JSON.parse(stdout) as { errors?: ReadonlyArray<{ message?: string }> }
    for (const error of report.errors ?? []) message += `\n${error.message ?? ""}`
  } catch {
    // A non-JSON tool failure still has stderr; never print its unstructured stdout.
  }
  for (const [name, value] of Object.entries(env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH/i.test(name) && value !== undefined && value !== "") message = message.replaceAll(value, "[redacted]")
  }
  return redact(message).trim()
}
