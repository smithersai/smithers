import { test as base, type BrowserContextOptions } from "@playwright/test"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { DEV_URL } from "../dev/https"
import { DEVICE_PERSON_HEADER, type Role, ROLES } from "../src/features/auth/contract"

// What the e2e tests run against, and what each test needs from it (docs/rules.md, test.e2e-declared-needs). One suite
// runs locally against `alchemy dev` and against a deployment (docs/rulings.md TEST-4). A test that needs something a
// target lacks says so with `requires`: it skips there with that need's reason, and the run's summary
// (e2e/summary.ts) lists it. A test known to fail on a target is marked with `broken` (TEST-5). Nothing else may skip.

export type Target = "local" | "deployment"

/** Whether `url` is a dev server on this machine, whose certificate may be self-signed (dev/https.ts). */
export const onThisMachine = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)

/** `BASE_URL` when it is an http(s) URL; anything else, such as the "/" Vite gives vitest, names no app. */
export const appURLOf = (env: { readonly BASE_URL?: string | undefined }) =>
  env.BASE_URL !== undefined && /^https?:\/\//.test(env.BASE_URL) ? env.BASE_URL : undefined

/**
 * The target `env` names: `E2E_TARGET` when set, else a deployment when `BASE_URL` points off this machine. A local
 * stack that signs in through GitHub, as a deployment does, runs as one with `E2E_TARGET=deployment`.
 */
export const targetOf = (env: { readonly E2E_TARGET?: string | undefined; readonly BASE_URL?: string | undefined }): Target => {
  const named = env.E2E_TARGET ?? ""
  if (named === "local" || named === "deployment") return named
  if (named !== "") throw new Error(`E2E_TARGET is "${named}": it must be local or deployment`)
  const url = appURLOf(env)
  return url === undefined || onThisMachine(url) ? "local" : "deployment"
}

/** The app the tests open: `BASE_URL`, or the local dev server. */
export const baseURL = appURLOf(process.env) ?? DEV_URL

export const target: Target = targetOf(process.env)

/** Who a run is signed in as: the deployment's test account, or local development's Admin (worker/DevChatApi.ts). */
export type Identity = { readonly origin: string; readonly login: string; readonly personId: string; readonly role: Role | null }

/** Local development's person, signed in until a test signs them out. */
export const LOCAL_DEVELOPER: Identity = { origin: new URL(baseURL).origin, login: "local-developer", personId: "local-developer", role: "admin" }

/**
 * Where a deployment's stored session lives: one folder per host, outside the repository so every workspace shares one
 * session and no copy of the checkout carries it. `E2E_SESSION_DIR` moves the root.
 */
export const sessionFiles = (url: string, env: { readonly E2E_SESSION_DIR?: string | undefined } = process.env) => {
  const dir = join(env.E2E_SESSION_DIR ?? join(homedir(), ".smithers-e2e"), new URL(url).host.replace(/[^a-z0-9.-]/gi, "_"))
  return { dir, session: join(dir, "session.json"), identity: join(dir, "identity.json"), conversation: join(dir, "conversation.json") }
}

/** Where a deployment run asks: the test account's own branch, private to it, and that branch's conversation. */
export type Place = { readonly path: string; readonly conversationId: string }

/**
 * The branch a deployment run asks in, so its questions never reach the team's home conversation that every Member
 * reads: tracked first by the test account, it stays the account's own until shared (docs/features/branch-workspace.md).
 */
export const OWN_BRANCH = { owner: "roninjin10", name: "smithers-github-tests", ref: "smithers-e2e" } as const

/** Reads the place the setup tracked; undefined when it couldn't track one (e2e/deployment/sign-in.setup.ts). */
export const readPlace = (path: string): Place | undefined => {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  const value = JSON.parse(text) as Partial<Place>
  if (typeof value.path !== "string" || typeof value.conversationId !== "string") {
    throw new Error(`${path} is not a place the e2e setup wrote; delete it and run the setup again`)
  }
  return { path: value.path, conversationId: value.conversationId }
}

/** Reads an identity file the setup wrote (e2e/deployment/sign-in.setup.ts); undefined when there is none yet. */
export const readIdentity = (path: string): Identity | undefined => {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  const value = JSON.parse(text) as Partial<Identity>
  const role = value.role ?? null
  if (typeof value.login !== "string" || typeof value.personId !== "string" || typeof value.origin !== "string" || (role !== null && !ROLES.includes(role))) {
    throw new Error(`${path} is not an identity the e2e setup wrote; delete it and run the setup again`)
  }
  return { origin: value.origin, login: value.login, personId: value.personId, role }
}

/** The person this run is signed in as. In a deployment, the setup project must have run. */
export const me = (): Identity => {
  if (target === "local") return LOCAL_DEVELOPER
  const path = sessionFiles(baseURL).identity
  const identity = readIdentity(path)
  if (identity === undefined) throw new Error(`No ${path}: run the deployment's setup project first (pnpm e2e:prod)`)
  return identity
}

/** A browser context with no session: in a deployment project every context starts from the stored session otherwise. */
export const signedOut: Pick<BrowserContextOptions, "storageState"> = { storageState: { cookies: [], origins: [] } }

const MEMBER_OR_ABOVE: ReadonlySet<Role | null> = new Set<Role | null>(["admin", "maintainer", "member"])
const MAINTAINER_OR_ABOVE: ReadonlySet<Role | null> = new Set<Role | null>(["admin", "maintainer"])

/** What a run offers a test: its target, who it is signed in as (read only when a need asks), and its environment. */
export type Run = {
  readonly target: Target
  /** Whether the app under test is `alchemy dev` on this machine, a dev build, even when it signs in through GitHub. */
  readonly devBuild?: boolean
  readonly role: () => Role | null
  readonly env: Readonly<Record<string, string | undefined>>
  /** Whether a deployment run has its own conversation to ask in (read only when a need asks). */
  readonly ownConversation?: () => boolean
}

const set = (run: Run, ...names: ReadonlyArray<string>) => names.every((name) => (run.env[name] ?? "") !== "")

/** The dev server's own settings file, apps/mvp/.env, which `alchemy dev` reads. */
export const DOT_ENV = join(dirname(fileURLToPath(import.meta.url)), "..", ".env")

/** Whether the dotenv file at `path` gives `name` a value. Presence only: the value is never read out. */
export const dotEnvSets = (path: string, name: string): boolean => {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return false
  }
  const line = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(?:"[^"\\s][^"]*"|'[^'\\s][^']*'|[^\\s"'#])`)
  return text.split(/\r?\n/).some((each) => line.test(each))
}

/** The key the dev server's model endpoint reaches its default model with (worker/ModelRoles.ts `DEFAULT_CHAT_MODEL`). */
const MODEL_KEY = "CEREBRAS_API_KEY"

/**
 * A need: when a run meets it, and why a test that has it skips otherwise. A `blocked` need is a prerequisite the run
 * lacks, such as the test account's role, not something the target can never offer: the summary fails the run for it.
 */
export type Need = { readonly met: (run: Run) => boolean; readonly reason: string; readonly blocked?: true }

const localOnly = (reason: string): Need => ({ met: (run) => run.target === "local", reason })

/** A need a dev build meets, wherever it runs: locally, or a stack on this machine that signs in through GitHub. */
const devBuildOnly = (reason: string): Need => ({ met: (run) => run.target === "local" || run.devBuild === true, reason })

/** Where the deployed build device-upgrade.spec.ts upgrades from sits: `OLD_BUILD_DIR`, or the round-4 build's copy. */
export const oldBuildDir = (env: Run["env"]) => env.OLD_BUILD_DIR ?? join(homedir(), "Desktop", "smithers-mvp", "builds", "c6940ac53e5a")

/** Whether the local dev server signs people in through GitHub instead of as local development's people. */
const githubAppLocally = (run: Run) => set(run, "GITHUB_APP_CLIENT_ID")

/** Whether a deployment run names a scratch repository to write issues to, never a smithersai one. */
const scratchSet = (run: Run) =>
  run.target === "deployment" && /^[\w.-]+\/[\w.-]+$/.test(run.env.E2E_ISSUES_REPOSITORY ?? "") && !/^smithersai\//i.test(run.env.E2E_ISSUES_REPOSITORY!)

const needs = {
  faults: devBuildOnly("the app's faulty services (`/app?faults`, e2e/faults.ts) are in dev builds only"),
  scriptedAgent: devBuildOnly("the scripted model (`/app?agent=<script>`) is in dev builds only"),
  devPeople: {
    met: (run) => run.target === "local" && !githubAppLocally(run),
    reason: "local development's second and third people (the smithers_dev_person cookie) exist only without GitHub sign-in; a deployment needs another real test account",
  },
  outsideRoles: {
    met: (run) => run.target === "deployment",
    reason: "it proves the test account's role on the deployment's repository counts for nothing where the GitHub App isn't installed (decision 0079); local development without the App keeps its people's roles on every repository",
  },
  vibelangMaintainer: {
    met: (run) => run.target === "local",
    reason: "it needs the test account to be a Maintainer or Admin on smithersai/vibelang (maintain or admin there on GitHub); the deployment says it is less",
    blocked: true,
  },
  devSignIn: {
    met: (run) => run.target === "local" && !githubAppLocally(run),
    reason: "it signs out and in as local development's person, who exists only without GitHub sign-in; in a deployment that would end the run's shared session",
  },
  sandboxSecrets: {
    met: (run) =>
      run.target === "local" && run.env.SANDBOX_SECRETS === "true" &&
      (run.env.GITHUB_REPOSITORY ?? "").toLowerCase() === "octocat/spoon-knife",
    reason: "a branch box's secrets egress is off unless the dev server runs with SANDBOX_SECRETS=true, and the fixture's secrets are writable only with GITHUB_REPOSITORY=octocat/Spoon-Knife (docs/features/secrets.md#wiring-into-the-box)",
  },
  localLogs: {
    met: (run) => run.target === "local" || set(run, "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"),
    reason: "it reads ChatApi's records: locally from .alchemy/log, in a deployment through a Cloudflare tail (e2e/logs.ts), which needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID",
  },
  localServer: localOnly("it serves fixtures or builds from this machine, which a deployment can't reach"),
  homeConversation: localOnly(
    "it leaves a view in the home conversation, which every Member of a deployment reads; a deployment run writes only its own branch's conversation",
  ),
  noGitHubApp: {
    met: (run) => run.target === "local" && !set(run, "GITHUB_APP_ID") && !set(run, "E2E_ISSUES_REPOSITORY"),
    reason: "it needs a repository GitHub hasn't said is public: a dev server without the GitHub App (GITHUB_APP_ID and E2E_ISSUES_REPOSITORY unset)",
  },
  webhookSecret: {
    met: (run) => set(run, "E2E_GITHUB_WEBHOOK_SECRET"),
    reason: "it signs GitHub's deliveries as GitHub does: set E2E_GITHUB_WEBHOOK_SECRET to the app's GITHUB_WEBHOOK_SECRET, the dev server's (with the GitHub App configured) or the deployment's",
  },
  alertProviders: {
    met: (run) =>
      run.target === "local" && set(run, "ALERT_TELEGRAM_API_URL") && run.env.ALERT_TELEGRAM_API_URL === run.env.ALERT_EMAIL_API_URL &&
      run.env.MODEL_SPEND_ALERTS === "true",
    reason: "it reads alerts from the local stand-in providers: start the dev server with ALERT_TELEGRAM_API_URL and ALERT_EMAIL_API_URL both at them and MODEL_SPEND_ALERTS=true",
  },
  oldBuild: {
    met: (run) => run.target === "local" && existsSync(join(oldBuildDir(run.env), "index.html")),
    reason: "it upgrades from a deployed build kept on this machine: put one at OLD_BUILD_DIR",
  },
  githubSignIn: { met: (run) => run.target === "deployment", reason: "it signs in through GitHub; local development signs its person in without GitHub" },
  codeStorage: {
    met: (run) => run.target === "deployment" || set(run, "CODE_STORAGE_ORG", "CODE_STORAGE_KEY"),
    reason: "it clones into Code Storage, which the local dev server reaches only with CODE_STORAGE_ORG and CODE_STORAGE_KEY set",
  },
  writableStack: {
    met: (run) => run.target === "local" ||
      (/^[\w.-]+\/[\w.-]+$/.test(run.env.E2E_STACK_REPOSITORY ?? "") && !/^smithersai\//i.test(run.env.E2E_STACK_REPOSITORY!)),
    reason: "it commits and drops TODOs: locally on octocat/Spoon-Knife; a deployment needs E2E_STACK_REPOSITORY naming a writable scratch repository with stack shapes and repository membership, never a smithersai one",
  },
  syncedRepository: {
    met: (run) => /^[\w.-]+\/[\w.-]+$/.test(run.env.E2E_SYNCED_REPOSITORY ?? ""),
    reason: "it needs existing synced issues and pull requests: set E2E_SYNCED_REPOSITORY to the deployment's synced public owner/name; an empty or unfinished sync fails the fixture check",
    blocked: true,
  },
  modelQuotaRefusal: {
    met: (run) => run.env.E2E_MODEL_QUOTA_REFUSED === "1",
    reason: "it needs a real deployment model refusing for quota or credit: set E2E_MODEL_QUOTA_REFUSED=1 only while that provider is refusing",
  },
  liveModel: {
    met: (run) =>
      (run.target === "deployment" ? set(run, "E2E_PERSONAL_MODEL_KEY") : set(run, MODEL_KEY)) || (run.target === "local" && dotEnvSets(run.env.E2E_DOT_ENV ?? DOT_ENV, MODEL_KEY)),
    reason: "it waits for the real model's answers: a deployment with E2E_PERSONAL_MODEL_KEY saved and tested by setup, or a local dev server with CEREBRAS_API_KEY set in its environment or apps/mvp/.env (the Mac mini's dev server has no model)",
  },
  personalModel: {
    met: (run) => run.target === "local" || set(run, "E2E_PERSONAL_MODEL_KEY"),
    reason: "deployment answers require the test account's saved model: set E2E_PERSONAL_MODEL_KEY; setup saves it and verifies Test before specs run",
  },
  personalModelKey: {
    met: (run) => set(run, "E2E_PERSONAL_MODEL_KEY"),
    reason: "it saves a real provider's key as the person's own model: set E2E_PERSONAL_MODEL_KEY, with optional E2E_PERSONAL_MODEL_BASE_URL, E2E_PERSONAL_MODEL_ID and E2E_PERSONAL_MODEL_PROTOCOL",
  },
  hostedModelOff: {
    met: (run) => run.target === "deployment" ? run.env.E2E_HOSTED_MODEL !== "on" : run.env.HOSTED_MODEL_ENABLED === "false",
    reason: "it needs the deployment's own model off (decision 0099): a deployment, as a deploy leaves it unless E2E_HOSTED_MODEL=on says an Admin turned it on, or a local dev server started with HOSTED_MODEL_ENABLED=false",
  },
  factoryRepository: {
    met: (run) => run.target === "deployment" && set(run, "E2E_FACTORY_REPOSITORY") && !/^smithersai\//i.test(run.env.E2E_FACTORY_REPOSITORY!),
    reason: "it runs TODOs to pull requests: run against a live instance whose GITHUB_REPOSITORY is a scratch repository, named in E2E_FACTORY_REPOSITORY, never a smithersai one",
  },
  githubScratch: {
    met: scratchSet,
    reason: "it writes issues to GitHub as a real person: run against a deployment with E2E_ISSUES_REPOSITORY set to a scratch repository; this permits writes but does not promise synced shapes, never a smithersai one",
  },
  syncedScratch: {
    met: (run) => scratchSet(run) &&
      run.env.E2E_ISSUES_REPOSITORY!.toLowerCase() === (run.env.E2E_SYNCED_REPOSITORY ?? run.env.GITHUB_REPOSITORY ?? "smithersai/smithers").toLowerCase(),
    reason: "it needs synced issue shapes, triage and stack writes: E2E_ISSUES_REPOSITORY must name the deployment's synced scratch repository (E2E_SYNCED_REPOSITORY), never smithersai; use a dedicated scratch deployment",
  },
  secondRepository: {
    met: (run) =>
      scratchSet(run) &&
      run.env.E2E_ISSUES_REPOSITORY!.toLowerCase() !== (run.env.E2E_SYNCED_REPOSITORY ?? run.env.GITHUB_REPOSITORY ?? "smithersai/smithers").toLowerCase(),
    reason: "it opens an issue on a repository other than the deployment's own (decision 0079): run against a deployment whose GITHUB_REPOSITORY, E2E_SYNCED_REPOSITORY (smithersai/smithers unless set), isn't the scratch repository E2E_ISSUES_REPOSITORY",
  },
  dogfood: {
    met: (run) => run.target === "deployment" && run.env.E2E_DOGFOOD === "smithersai/smithers",
    reason: "it builds Smithers with Smithers on the deployment: it opens a real issue on smithersai/smithers and runs TODOs to pull requests there, so it runs only when E2E_DOGFOOD names that repository (apps/mvp/docs/work/dogfood-loop.md)",
  },
  repoFlows: {
    met: (run) =>
      /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(run.env.E2E_REPO_FLOWS_REPOSITORY ?? "") &&
      !/^smithersai\//i.test(run.env.E2E_REPO_FLOWS_REPOSITORY!),
    reason: "it runs repository CI: set E2E_REPO_FLOWS_REPOSITORY to a scratch owner/name (never smithersai); its default branch must hold e2e/fixtures/ci-repo and the target must have REPO_FLOWS=true, REPO_FLOWS_REPOSITORIES allowing it, and the GitHub App installed with Contents and Commit statuses write",
  },
  githubAppKey: {
    met: (run) => set(run, "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"),
    reason: "the deployment's pusher is the App installation: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY through the vault's environment wrapper",
  },
  githubPushToken: {
    met: (run) => set(run, "E2E_GITHUB_TOKEN"),
    reason: "local development pushes as a person: set E2E_GITHUB_TOKEN to a token with Contents write on the scratch repository",
  },
  githubApp: {
    met: (run) => run.target === "deployment",
    reason: "it syncs the deployment's GitHub repository through its GitHub App and webhook, which local development runs without",
  },
  longRun: {
    met: (run) => run.target === "deployment" && run.env.E2E_LONG === "1",
    reason: "it waits out a deployment's own window (the spend alert's 15 minutes, an answer's 25, a role's hour), which local development shortens or turns off: set E2E_LONG=1 against a deployment",
  },
  member: {
    met: (run) => MEMBER_OR_ABOVE.has(run.role()),
    reason: "it asks, clones or tracks, which needs a Member or above; the test account's role on the deployment's repository is below that",
    blocked: true,
  },
  ownConversation: {
    met: (run) => run.target === "local" || (run.ownConversation?.() ?? false),
    reason: "it asks Smithers, and a deployment run asks only in the test account's own branch conversation, never the team's home; the setup tracks that branch once the deployment can clone its repository",
    blocked: true,
  },
  maintainer: {
    met: (run) => MAINTAINER_OR_ABOVE.has(run.role()),
    reason: "it needs a Maintainer or above; the test account's role on the deployment's repository is below that",
    blocked: true,
  },
  bugReader: {
    met: (run) => run.target === "local" || set(run, "E2E_BUG_READ_TOKEN"),
    reason: "it reads the stored bug report as an Admin: locally as local development's Admin, in a deployment with " +
      "E2E_BUG_READ_TOKEN set to the deployment's BUG_REPORTS_READ_TOKEN (docs/features/bugs.md#the-routes)",
  },
  docsSite: {
    met: (run) => {
      const url = appURLOf(run.env)
      return run.target === "deployment" && url !== undefined && !new URL(url).hostname.endsWith(".workers.dev")
    },
    reason: "the docs site answers beside the app only on a deployment's custom domain (APP_DOMAIN, infra/DocsSite.ts), " +
      "not at its workers.dev URL or under alchemy dev",
  },
} satisfies Record<string, Need>

export type NeedName = keyof typeof needs

/** Every need a test may declare, with its reason. */
export const NEEDS: Readonly<Record<NeedName, Need>> = needs

/** What a known-broken entry says: the targets it breaks and why (TEST-5). */
export type Broken = { readonly in: ReadonlyArray<Target>; readonly reason: string; readonly when?: (run: Run) => boolean }

/**
 * Behavior known to fail on a target (TEST-5), by name: `broken(name)` marks a test that fails there for that reason.
 * Remove an entry and its marks once the behavior is fixed.
 */
export const KNOWN_BROKEN: Readonly<Record<string, Broken>> = {
  vibelangRoles: {
    in: ["deployment"],
    when: (run) => (run.env.GITHUB_REPOSITORY ?? run.env.E2E_SYNCED_REPOSITORY ?? "smithersai/smithers").toLowerCase() !== "smithersai/vibelang",
    reason: "the VibeLang maintainer journeys need a Maintainer or Admin of smithersai/vibelang, which the test account isn't, on a deployment whose GITHUB_REPOSITORY is another; the home resolves that role per repository (decision 0079)",
  },
  staleMirror: {
    in: ["deployment"],
    reason: "production's Code Storage mirror of smithersai/vibelang lags GitHub, so the pinned grammar commit 3ad97368 answers 404 until mirrors follow GitHub's new commits",
  },
  telemetryTail: {
    in: ["deployment"],
    reason: "the live tail omits browser collector invocations despite fully consumed successful acknowledgments; stored-log comparison is pending",
  },
}

export type BrokenName = string

/** A skip's or a broken mark's description: the need's name, then its reason. The summary reads the name back. */
export const describeNeed = (name: NeedName) => `${NEEDS[name].blocked ? "blocked" : "needs"} ${name}: ${NEEDS[name].reason}`
export const describeBroken = (name: BrokenName) => `broken ${name}: ${KNOWN_BROKEN[name]!.reason}`

/** The need or broken mark a description names, if any: `needs faults: …` is `faults`. */
export const parseDescription = (description: string | undefined): { kind: "needs" | "blocked" | "broken"; name: string } | undefined => {
  const match = /^(needs|blocked|broken) ([A-Za-z]+): /.exec(description ?? "")
  if (match === null) return undefined
  const [, kind, name] = match as unknown as [string, "needs" | "blocked" | "broken", string]
  const known = kind === "broken" ? name in KNOWN_BROKEN : name in NEEDS && (NEEDS[name as NeedName].blocked === true) === (kind === "blocked")
  return known ? { kind, name } : undefined
}

/** The place this deployment run asks in, if the setup tracked one; locally, the app's home. */
export const ownPlace = (): Place | undefined => (target === "local" ? undefined : readPlace(sessionFiles(baseURL).conversation))

const thisRun: Run = {
  target,
  devBuild: onThisMachine(baseURL),
  role: () => me().role,
  env: process.env,
  ownConversation: () => ownPlace() !== undefined,
}

/** Whether this run meets `name`. */
export const meets = (name: NeedName, run: Run = thisRun) => NEEDS[name].met(run)

const inTest = () => {
  try {
    base.info()
    return true
  } catch {
    return false
  }
}

/**
 * Declares what a test (called in its body) or every test of a file or describe block (called there) needs. Where the
 * run doesn't meet a need, the test skips with that need's reason; a deployment's role is read when the test starts.
 */
export const requires = (...names: ReadonlyArray<NeedName>) => {
  for (const name of names) {
    if (inTest()) {
      record(name)
      base.skip(!meets(name), describeNeed(name))
    } else {
      // A modifier's condition may be read once per worker, so a hook records the need for each test of the scope.
      base.beforeEach(() => record(name))
      base.skip(() => !meets(name), describeNeed(name))
    }
  }
}

/** The needs each running test declared, by its TestInfo: helpers such as `devices.open` adapt to them. */
const declaredBy = new WeakMap<object, Set<NeedName>>()

const record = (name: NeedName) => {
  if (!inTest()) return
  const info = base.info()
  const names = declaredBy.get(info) ?? new Set<NeedName>()
  names.add(name)
  declaredBy.set(info, names)
}

/** Whether the running test declared `name`: a test that declared `ownConversation` opens the app in it. */
export const declared = (name: NeedName) => (inTest() ? (declaredBy.get(base.info())?.has(name) ?? false) : false)

/** Whether a known failure applies to this target and its repository configuration. */
export const brokenOn = (name: BrokenName, run: Run = thisRun) => {
  const entry = KNOWN_BROKEN[name]
  if (entry === undefined) throw new Error(`No known-broken entry ${name} in KNOWN_BROKEN (e2e/target.ts)`)
  return entry.in.includes(run.target) && (entry.when?.(run) ?? true)
}

/** Marks a test (in its body) or a file or describe block as failing on the targets `name` breaks (TEST-5). */
export const broken = (name: BrokenName) => {
  if (inTest()) base.fail(brokenOn(name), describeBroken(name))
  else base.fail(() => brokenOn(name), describeBroken(name))
}

/**
 * Whether this test, in its body, may also check what `name` offers: where the run doesn't meet it, the test runs
 * without that part, and its `partly` annotation tells the summary which part it left out.
 */
export const partly = (name: NeedName) => {
  const met = meets(name)
  if (!met) base.info().annotations.push({ type: "partly", description: describeNeed(name) })
  return met
}

/** A test used something its target lacks without declaring it: fail at once, saying which `requires` is missing. */
export class UndeclaredNeed extends Error {
  constructor(readonly need: NeedName) {
    super(`This test needs ${need} (${NEEDS[need].reason}). Declare it with requires("${need}").`)
    this.name = "UndeclaredNeed"
  }
}

/** Called by a helper that only works where `name` is met, so a test that forgot `requires` fails fast and says why. */
export const guard = (name: NeedName, run: Run = thisRun) => {
  if (!NEEDS[name].met(run)) throw new UndeclaredNeed(name)
}

/**
 * The app's address with its agent's model scripted (src/test/scriptedAgent.ts): `/app?agent=echo`, or `?agent=echo`
 * after `path` "" for a page that adds it to its own. A dev build only: `requires("scriptedAgent")`.
 */
export const scriptedAgent = (script: string, path = "/app", run: Run = thisRun) => {
  guard("scriptedAgent", run)
  return `${path}?agent=${script}`
}

/**
 * Where a test that asks opens the app: `/app` locally, the test account's own branch in a deployment. Called in a
 * test's body, it declares `ownConversation`, so a deployment run without one skips the test as blocked.
 */
export const home = () => {
  requires("personalModel", "ownConversation")
  return appHome()
}

/**
 * Where the app opens for a test: its run's own branch, in a deployment that has one, for a test that declared
 * `ownConversation`; else `/app`. It declares nothing.
 */
export const appHome = () => (declared("ownConversation") ? ownPlace()?.path : undefined) ?? "/app"

/** Whether `url` is the run's own branch: a page there asks in the run's own conversation. */
export const atOwnPlace = (url: string) => {
  const place = ownPlace()
  return place !== undefined && new URL(url).pathname.startsWith(place.path)
}

/** A page's URL ending at `appHome()`, for a tab that should still be where it opened. */
export const atAppHome = () => new RegExp(`${appHome().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)

/**
 * A question to post straight to ChatApi (`POST /api/questions`), as a second API client does: in a deployment, in the
 * run's own conversation and bound to the run's person (decision 0023), never in the team's home.
 */
export const questionPost = (body: { readonly id: string; readonly answerId: string; readonly text: string }) => {
  requires("personalModel")
  const place = ownPlace()
  return {
    data: place === undefined ? body : { ...body, conversationId: place.conversationId },
    headers: writeHeaders(),
  }
}

/** The headers a write to ChatApi carries: in a deployment, the person it expects (decision 0023). */
export const writeHeaders = (): Record<string, string> =>
  target === "deployment" ? { origin: new URL(baseURL).origin, [DEVICE_PERSON_HEADER]: me().personId } : {}

/** The scratch repository issue specs write to, `owner/name` (the `githubScratch` need). */
export const scratchRepository = () => {
  guard("githubScratch")
  return process.env.E2E_ISSUES_REPOSITORY!
}

/** The writable scratch stack this run may commit and drop TODOs on (the `writableStack` need). */
export const stackRepository = (run: Run = thisRun) => {
  guard("writableStack", run)
  return run.target === "local" ? "octocat/Spoon-Knife" : run.env.E2E_STACK_REPOSITORY!
}

/** The explicitly selected repository whose real synced items this run reads. */
export const syncedRepository = (run: Run = thisRun) => {
  guard("syncedRepository", run)
  return run.env.E2E_SYNCED_REPOSITORY!
}
