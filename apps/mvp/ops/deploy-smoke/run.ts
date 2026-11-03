// The deploy smoke (docs/infrastructure.md#the-deploy-smoke): the one command to run after every production deploy.
//
//   cd apps/mvp && ~/vault-ws-deployer/bin/mvp-prod-env node ops/deploy-smoke/run.ts
//
// It runs `SPECS` one after another in each of `PROJECTS` through `node e2e/prod.mjs`, which takes run.lock for each, prints one pass or fail
// line per spec, and exits non-zero on any failure, having run them all. It finds production's Neon project itself: the
// one in NEON_ORG_ID that Alchemy named for the stage. A spec's own output goes to a file it names, never a secret here.
import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectNamePattern, scrub, secretsOf } from "../feed-barrier/confirm.ts"
import { refuseUncheckedTls } from "../tls.mjs"

/** What the smoke runs, in order. Short and fast: each proves a failure that reached production once. */
export const SPECS: ReadonlyArray<string> = [
  // A role row past its life: the first paint never 503s the page's own reads (a1d9a5d5, rolled back). Its last visit
  // leaves the row fresh, which the next spec's paint needs.
  "e2e/cold-path.spec.ts",
  // Nothing covers search or New issue while a page syncs (a1d9a5d5).
  "e2e/first-paint.spec.ts",
]

/** The browsers each spec runs in, one run after the other: each once broke alone. */
export const PROJECTS: ReadonlyArray<string> = ["deployment", "webkit"]

/** The stage's one database project in the organization; anything else is an error, never a guess. */
export const findProject = async (
  options: { readonly key: string; readonly orgId: string; readonly stage: string },
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> => {
  const response = await fetch(`https://console.neon.tech/api/v2/projects?org_id=${encodeURIComponent(options.orgId)}&limit=400`, {
    headers: { authorization: `Bearer ${options.key}`, accept: "application/json" },
  })
  if (!response.ok) throw new Error(`Neon answered ${response.status} listing projects`)
  const { projects } = (await response.json()) as { readonly projects: ReadonlyArray<{ readonly id: string; readonly name: string }> }
  const matching = projects.filter((project) => projectNamePattern(options.stage).test(project.name))
  if (matching.length !== 1) throw new Error(`expected one ${options.stage} database project, found ${matching.length}`)
  return matching[0]!.id
}

/** Runs each spec with `runSpec`, every one whatever the last did; one line each. Answers the exit code. */
export const smoke = async (
  specs: ReadonlyArray<string>,
  runSpec: (spec: string, project: string) => Promise<{ readonly code: number; readonly log: string; readonly seconds: number }>,
  out: (line: string) => void,
  projects: ReadonlyArray<string> = PROJECTS,
): Promise<number> => {
  let failed = 0
  for (const project of projects) {
    for (const spec of specs) {
      const { code, log, seconds } = await runSpec(spec, project)
      if (code !== 0) failed++
      out(`${code === 0 ? "pass" : "FAIL"}  ${project}  ${spec}  ${seconds} s${code === 0 ? "" : `  exit ${code}, log ${log}`}`)
    }
  }
  const runs = specs.length * projects.length
  out(failed === 0 ? `deploy smoke passed: ${runs} runs` : `deploy smoke FAILED: ${failed} of ${runs} runs`)
  return failed === 0 ? 0 : 1
}

/**
 * Whether a run's summary (e2e/summary.ts) shows `spec` ran for real: at least one test passed, and none failed, broke,
 * skipped or was blocked. A spec skipped for a missing need exits 0, and proves nothing.
 */
export const ranForReal = (summary: string, spec: string): boolean => {
  const name = spec.slice(spec.lastIndexOf("/") + 1).replaceAll(".", "\\.")
  const row = new RegExp(`^${name}\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s*$`, "m").exec(summary)
  if (row === null) return false
  const [passed, ...rest] = row.slice(1)
  return /^[1-9]\d*$/.test(passed!) && rest.every((count) => count === "·")
}

/** What `node` runs for one spec. */
export const specArgs = (spec: string, project: string): ReadonlyArray<string> => ["e2e/prod.mjs", spec, `--project=${project}`]

/** One spec through `node e2e/prod.mjs`, its output in a file. A run that exits 0 without running for real fails. */
const viaProd = (env: NodeJS.ProcessEnv, directory: string) => (spec: string, project: string) =>
  new Promise<{ readonly code: number; readonly log: string; readonly seconds: number }>((resolve, reject) => {
    const log = join(directory, `${project}-${spec.replace(/\W+/g, "-")}.log`)
    const started = Date.now()
    const file = openSync(log, "w")
    const child = spawn("node", [...specArgs(spec, project)], { env, stdio: ["ignore", file, file] })
    child.on("error", reject)
    child.on("close", (code) => {
      closeSync(file)
      const exited = code ?? 1
      resolve({ code: exited === 0 && !ranForReal(readFileSync(log, "utf8"), spec) ? 1 : exited, log, seconds: Math.round((Date.now() - started) / 1000) })
    })
  })

/** The command: what it needs from the environment, then the smoke. */
export const run = async (
  env: NodeJS.ProcessEnv,
  out: (line: string) => void,
  err: (line: string) => void,
  fetch: typeof globalThis.fetch = globalThis.fetch,
  specRunner: (env: NodeJS.ProcessEnv, directory: string) => (spec: string, project: string) => ReturnType<ReturnType<typeof viaProd>> = viaProd,
): Promise<number> => {
  try {
    refuseUncheckedTls(env)
    if (env.APP_DOMAIN === undefined || env.APP_DOMAIN === "") throw new Error("APP_DOMAIN is not set: run under mvp-prod-env")
    if (env.NEON_API_KEY === undefined || env.NEON_API_KEY === "") throw new Error("NEON_API_KEY is not set: run under mvp-prod-env")
    if (env.NEON_ORG_ID === undefined || env.NEON_ORG_ID === "") throw new Error("NEON_ORG_ID is not set: run under mvp-prod-env")
    const project = await findProject({ key: env.NEON_API_KEY, orgId: env.NEON_ORG_ID, stage: "prod" }, fetch)
    const directory = join(tmpdir(), `deploy-smoke-${Date.now()}`)
    mkdirSync(directory, { recursive: true })
    return await smoke(SPECS, specRunner({ ...env, E2E_PROD_URL: `https://${env.APP_DOMAIN}`, E2E_ROLE_EXPIRE_PROJECT: project }, directory), out)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    err(scrub(`deploy smoke not run: ${message.split("\n")[0]}`, secretsOf(env)))
    return 2
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.env, (line) => console.log(line), (line) => console.error(line)).then((code) => process.exit(code), () => process.exit(2))
}
