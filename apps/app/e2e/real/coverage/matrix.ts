import { existsSync, readFileSync } from "node:fs"
import { AppBootstrapSchema } from "@smthrs/rpc/AppBootstrap"
import type { RuntimeCapability } from "@smthrs/rpc/AppBootstrap"
import { DEPLOYMENT_MODES } from "./types"
import type { DeploymentMode, RealHost, RealScenarioRunEvidence } from "./types"

export type MatrixTier = "deterministic" | "local-infrastructure" | "live-provider" | "plue-production"
export type MatrixStatus = "passed" | "failed" | "unavailable"
export type ProductProvider = "selfhost" | "plue"
export type ProductSurface = "web" | "local" | "native"
export type ProcessRole = "web" | "local-ui" | "native-ui" | "supervisor" | "app" | "docker-app" | "postgres"
const PROCESS_ROLES: readonly ProcessRole[] = ["web", "local-ui", "native-ui", "supervisor", "app", "docker-app", "postgres"]

export interface ModeDescriptor {
  readonly id: DeploymentMode
  readonly surface: ProductSurface
  readonly provider: ProductProvider
  readonly legacyHost: RealHost
  readonly requiredProcessRoles: readonly ProcessRole[]
  readonly forbiddenProcessRoles: readonly ProcessRole[]
  readonly requiresPersistentRestart: boolean
}

interface MatrixScenario {
  readonly id: string
  readonly capabilities: readonly RuntimeCapability[]
}

interface MatrixObligation {
  readonly id: string
  readonly scenarios: readonly MatrixScenario[]
  readonly tier: MatrixTier
}

export const MODE_DESCRIPTORS: Readonly<Record<DeploymentMode, ModeDescriptor>> = {
  "web-selfhost": {
    id: "web-selfhost", surface: "web", provider: "selfhost", legacyHost: "local",
    requiredProcessRoles: ["docker-app", "postgres"], forbiddenProcessRoles: [], requiresPersistentRestart: true
  },
  "web-plue": {
    id: "web-plue", surface: "web", provider: "plue", legacyHost: "production",
    requiredProcessRoles: ["web"], forbiddenProcessRoles: ["app", "docker-app", "postgres", "supervisor"], requiresPersistentRestart: false
  },
  "local-own": {
    id: "local-own", surface: "local", provider: "selfhost", legacyHost: "local",
    requiredProcessRoles: ["local-ui", "app", "postgres"], forbiddenProcessRoles: [], requiresPersistentRestart: true
  },
  "local-plue": {
    id: "local-plue", surface: "local", provider: "plue", legacyHost: "local",
    requiredProcessRoles: ["local-ui"], forbiddenProcessRoles: ["app", "docker-app", "postgres", "supervisor"], requiresPersistentRestart: false
  },
  "native-own": {
    id: "native-own", surface: "native", provider: "selfhost", legacyHost: "native",
    requiredProcessRoles: ["native-ui", "supervisor", "app", "postgres"], forbiddenProcessRoles: [], requiresPersistentRestart: true
  },
  "native-plue": {
    id: "native-plue", surface: "native", provider: "plue", legacyHost: "native",
    requiredProcessRoles: ["native-ui"], forbiddenProcessRoles: ["app", "docker-app", "postgres", "supervisor"], requiresPersistentRestart: false
  }
}

/** One obligation catalog. Modes inject topology; they do not copy scenario bodies. */
export const MATRIX_OBLIGATIONS: readonly MatrixObligation[] = [
  { id: "signed-in", scenarios: [{ id: "auth.session-preflight-cookie-persistence", capabilities: ["identity"] }], tier: "local-infrastructure" },
  { id: "repository-create", scenarios: [], tier: "local-infrastructure" },
  { id: "github-import", scenarios: [], tier: "live-provider" },
  { id: "chat", scenarios: [{ id: "chat.stream-grounded", capabilities: ["agent"] }], tier: "local-infrastructure" },
  { id: "tool", scenarios: [{ id: "chat.tool-browser-open", capabilities: ["agent", "browser.read"] }], tier: "local-infrastructure" },
  { id: "workspace", scenarios: [{ id: "workspaces.cloud-lifecycle-suspend-resume-delete", capabilities: ["identity", "cloud"] }], tier: "local-infrastructure" },
  { id: "terminal", scenarios: [{ id: "workspaces.cloud-terminal-keyboard-output", capabilities: ["identity", "cloud", "cloud.terminal"] }], tier: "local-infrastructure" },
  { id: "job-admission", scenarios: [{ id: "flows.production-create-reconnect-execute", capabilities: ["identity", "cloud"] }], tier: "local-infrastructure" },
  { id: "approval-decision", scenarios: [], tier: "local-infrastructure" },
  { id: "artifact", scenarios: [{ id: "issues.practice-live-implementation-artifacts", capabilities: [] }], tier: "local-infrastructure" },
  { id: "review", scenarios: [], tier: "local-infrastructure" },
  { id: "landing", scenarios: [{ id: "pull-requests.production-land-git-proof", capabilities: ["identity", "cloud"] }], tier: "local-infrastructure" },
  { id: "reload", scenarios: [{ id: "local-eventual-page-restart-persistence", capabilities: [] }], tier: "local-infrastructure" },
  { id: "cancel", scenarios: [
    { id: "chat.stop-real-turn", capabilities: ["agent"] },
    { id: "flows.production-provider-cancel", capabilities: ["identity", "cloud"] }
  ], tier: "local-infrastructure" },
  { id: "recovery", scenarios: [
    { id: "chat.failure-retry-process", capabilities: ["agent"] },
    { id: "navigation.storage.opfs-failure-recovery", capabilities: [] }
  ], tier: "local-infrastructure" }
]

export const MATRIX_SCENARIO_IDS = [...new Set(MATRIX_OBLIGATIONS.flatMap((entry) => entry.scenarios.map(({ id }) => id)))]

export const MANDATORY_DETERMINISTIC_BUN_TESTS = [
  "src/mainview/state/controller/workflows.test.ts",
  "src/mainview/state/controller/liveTutorial.test.ts",
  "src/mainview/state/controller/failures.test.ts"
] as const

export const MANDATORY_DETERMINISTIC_BROWSER_SPECS = [
  "e2e/playwright/flow-launch-background.spec.ts",
  "e2e/playwright/tutorial-live-background.spec.ts",
  "e2e/playwright/toast-stack.spec.ts"
] as const

export interface ModeConfig {
  readonly mode: DeploymentMode
  readonly origin: string
  readonly auth: { readonly kind: "browser-profile" | "owner-session"; readonly environment: string }
  readonly executionReceipt: string
}

export interface MatrixConfig {
  readonly revision: string
  readonly modes: readonly ModeConfig[]
}

export interface ExecutionReceipt {
  readonly mode: DeploymentMode
  readonly revision: string
  readonly origin: string
  readonly ready: boolean
  readonly startedRoles: readonly ProcessRole[]
  readonly freshLaunch: boolean
  readonly restarted: boolean
  readonly dataPreserved: boolean
  readonly observedAt: string
}

export interface ModeReadiness {
  readonly mode: DeploymentMode
  readonly status: MatrixStatus
  readonly tier: MatrixTier
  readonly origin?: string
  readonly capabilities: readonly string[]
  readonly reasons: readonly string[]
}

export interface MatrixScenarioReceipt {
  readonly mode: DeploymentMode
  readonly obligation: string
  readonly scenarioId?: string
  readonly tier: MatrixTier
  readonly status: MatrixStatus
  readonly revision: string
  readonly origin?: string
  readonly reason?: string
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const exactRevision = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value)
const deploymentMode = (value: unknown): value is DeploymentMode => typeof value === "string" && (DEPLOYMENT_MODES as readonly string[]).includes(value)

const httpOrigin = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("mode origin must be a string")
  const parsed = new URL(value)
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`mode origin must be a credential-free HTTP(S) origin: ${value}`)
  }
  return parsed.origin
}

export const parseMatrixConfig = (value: unknown): MatrixConfig => {
  if (!isObject(value) || !exactRevision(value.revision) || !Array.isArray(value.modes)) throw new Error("matrix config requires an exact revision and modes array")
  const seen = new Set<DeploymentMode>()
  const modes = value.modes.map((entry): ModeConfig => {
    if (!isObject(entry) || !deploymentMode(entry.mode) || !isObject(entry.auth) || typeof entry.executionReceipt !== "string") {
      throw new Error("every matrix mode requires mode, origin, auth, and executionReceipt")
    }
    if (seen.has(entry.mode)) throw new Error(`duplicate matrix mode ${entry.mode}`)
    seen.add(entry.mode)
    if ((entry.auth.kind !== "browser-profile" && entry.auth.kind !== "owner-session") || typeof entry.auth.environment !== "string" || !/^[A-Z][A-Z0-9_]+$/.test(entry.auth.environment)) {
      throw new Error(`${entry.mode} auth must name a browser-profile or owner-session environment variable`)
    }
    if (!entry.executionReceipt.trim()) throw new Error(`${entry.mode} executionReceipt is required`)
    return { mode: entry.mode, origin: httpOrigin(entry.origin), auth: { kind: entry.auth.kind, environment: entry.auth.environment }, executionReceipt: entry.executionReceipt }
  })
  return { revision: value.revision, modes }
}

export const readExecutionReceipt = (path: string): ExecutionReceipt => {
  if (!existsSync(path)) throw new Error(`execution receipt does not exist: ${path}`)
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown
  if (!isObject(value) || !deploymentMode(value.mode) || !exactRevision(value.revision) || typeof value.origin !== "string" || typeof value.ready !== "boolean" ||
      !Array.isArray(value.startedRoles) || value.startedRoles.some((role) => typeof role !== "string" || !(PROCESS_ROLES as readonly string[]).includes(role)) || typeof value.freshLaunch !== "boolean" ||
      typeof value.restarted !== "boolean" || typeof value.dataPreserved !== "boolean" || typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))) {
    throw new Error(`malformed execution receipt: ${path}`)
  }
  return value as unknown as ExecutionReceipt
}

export const validateExecutionReceipt = (config: ModeConfig, revision: string, receipt: ExecutionReceipt): readonly string[] => {
  const descriptor = MODE_DESCRIPTORS[config.mode]
  const reasons: string[] = []
  if (receipt.mode !== config.mode) reasons.push(`receipt mode ${receipt.mode} does not match ${config.mode}`)
  if (receipt.revision !== revision) reasons.push(`receipt revision ${receipt.revision} does not match ${revision}`)
  if (httpOrigin(receipt.origin) !== config.origin) reasons.push(`receipt origin ${receipt.origin} does not match ${config.origin}`)
  if (!receipt.ready) reasons.push("launcher did not report actual readiness")
  for (const role of descriptor.requiredProcessRoles) if (!receipt.startedRoles.includes(role)) reasons.push(`launcher did not prove ${role} started`)
  for (const role of descriptor.forbiddenProcessRoles) if (receipt.startedRoles.includes(role)) reasons.push(`remote mode unexpectedly started ${role}`)
  if (!receipt.freshLaunch) reasons.push("launcher did not prove a fresh launch")
  if (descriptor.requiresPersistentRestart && (!receipt.restarted || !receipt.dataPreserved)) reasons.push("persistent restart with preserved data was not proven")
  return reasons
}

export const probeMode = async (
  config: ModeConfig,
  revision: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: typeof fetch = fetch
): Promise<ModeReadiness> => {
  const reasons: string[] = []
  if (!environment[config.auth.environment]?.trim()) reasons.push(`auth environment ${config.auth.environment} is unavailable`)
  if (config.auth.kind === "owner-session") reasons.push("owner-session injection is not implemented by the real product fixture")
  try { reasons.push(...validateExecutionReceipt(config, revision, readExecutionReceipt(config.executionReceipt))) }
  catch (error) { reasons.push(error instanceof Error ? error.message : String(error)) }
  let capabilities: readonly string[] = []
  try {
    const health = await fetcher(new URL("/api/health", config.origin))
    if (!health.ok) reasons.push(`health returned HTTP ${health.status}`)
    const bootstrap = await fetcher(new URL("/api/bootstrap", config.origin))
    if (!bootstrap.ok) reasons.push(`bootstrap returned HTTP ${bootstrap.status}`)
    else {
      const parsed = AppBootstrapSchema.safeParse(await bootstrap.json())
      if (!parsed.success) reasons.push(`bootstrap contract is invalid: ${parsed.error.message}`)
      else capabilities = parsed.data.capabilities
    }
  } catch (error) { reasons.push(`readiness request failed: ${error instanceof Error ? error.message : String(error)}`) }
  return {
    mode: config.mode,
    status: reasons.length === 0 ? "passed" : "unavailable",
    tier: MODE_DESCRIPTORS[config.mode].provider === "plue" ? "plue-production" : "local-infrastructure",
    origin: config.origin,
    capabilities,
    reasons
  }
}

export const scenarioReceipts = (
  readiness: ModeReadiness,
  revision: string,
  runs: readonly RealScenarioRunEvidence[]
): readonly MatrixScenarioReceipt[] => MATRIX_OBLIGATIONS.flatMap((obligation): readonly MatrixScenarioReceipt[] => {
  const tier = readiness.tier === "plue-production" ? readiness.tier : obligation.tier
  if (obligation.scenarios.length === 0) return [{
    mode: readiness.mode, obligation: obligation.id, tier, status: "unavailable", revision,
    ...(readiness.origin ? { origin: readiness.origin } : {}), reason: "no real product scenario is implemented"
  }]
  return obligation.scenarios.map((scenario) => {
    const scenarioId = scenario.id
    const missingCapabilities = scenario.capabilities.filter((capability) => !readiness.capabilities.includes(capability))
    const attempts = runs.filter((run) => run.mode === readiness.mode && run.scenarioId === scenarioId && run.revision === revision)
    const failure = attempts.find((run) => run.status !== "passed")
    const passed = attempts.find((run) => run.status === "passed")
    const reason = readiness.status !== "passed" ? readiness.reasons.join("; ")
      : missingCapabilities.length > 0 ? `bootstrap does not advertise ${missingCapabilities.join(", ")}`
      : failure ? `unsuccessful attempt: ${failure.status}`
        : !passed ? "no executed receipt" : undefined
    const status: MatrixStatus = reason === undefined ? "passed"
      : readiness.status !== "passed" || missingCapabilities.length > 0 || failure === undefined ? "unavailable"
        : "failed"
    return {
      mode: readiness.mode, obligation: obligation.id, scenarioId, tier,
      status,
      revision, ...(readiness.origin ? { origin: readiness.origin } : {}), ...(reason ? { reason } : {})
    }
  })
})

export const missingModeReadiness = (mode: DeploymentMode, reason: string): ModeReadiness => ({
  mode,
  status: "unavailable",
  tier: MODE_DESCRIPTORS[mode].provider === "plue" ? "plue-production" : "local-infrastructure",
  capabilities: [],
  reasons: [reason]
})
