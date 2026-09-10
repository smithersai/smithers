/**
 * Scripted deploy: build the smithers.sh Astro site (apps/site), which carries
 * the product app as a prerendered React island, then deploy this package's
 * Worker with Alchemy (alchemy.run.ts → src/Worker.ts), recording a receipt
 * (git sha + timestamp + Cloudflare version id) either way.
 *
 *   bun scripts/deploy.ts --dry-run
 *     Runs the real site build, then `alchemy plan --stage prod`. The plan
 *     evaluates the stack — it loads src/Worker.ts, runs its init closure,
 *     registers the five Durable Object exports and reads every `Config` —
 *     and prints the resources and bindings it would reconcile. It does NOT
 *     read the live Cloudflare script (the live read and the adoption happen
 *     during apply), so it always prints `create` from an empty local state;
 *     what proves the adoption is safe is scripts/adopt-durable-objects.ts.
 *     Nothing is published. Receipt lands in deploy-receipts/dry-run/.
 *
 *   bun scripts/deploy.ts
 *     Real deploy. Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
 *     Runs scripts/adopt-durable-objects.ts first and stops on a red report,
 *     then `alchemy deploy --stage prod --adopt --yes`. Receipt lands in
 *     deploy-receipts/.
 *
 * The Worker identity (name `smithers-mvp-web`, the canary.smithers.sh domain,
 * the apex route, the five Durable Objects) is frozen in src/workerIdentity.ts;
 * see apps/server/DEPLOY.md. This script never changes it; it only builds and
 * deploys what's there.
 *
 * THE CLI RUNS UNDER BUN, ALWAYS. `node_modules/.bin/alchemy` is a launcher
 * (alchemy bin/cli.js:98-116) that re-execs the CLI under bun only when
 * `npm_execpath` contains "bun" or `npm_config_user_agent` starts with
 * "bun/", and under node otherwise. This package's modules import each other
 * without file extensions (`./src/Worker`, `./index`), which only a bundler
 * resolver understands, so the node path dies with
 * `Cannot find module .../src/Worker imported from alchemy.run.ts` before it
 * reads a single resource. `bun scripts/deploy.ts` sets neither variable, and
 * `pnpm run …` sets them to pnpm, so this script spawns bun on the CLI's own
 * TypeScript entry instead of trusting the launcher's sniffing.
 *
 * `--adopt` on every run: the state store is local and gitignored, so a fresh
 * checkout (CI) has none. A Worker carrying this stack's ownership tags reads
 * back as owned regardless (alchemy WorkerProvider.ts:5027-5035); `--adopt`
 * covers the first deploy, which adopts the Wrangler-deployed script.
 *
 * CN-1: the receipt records the sha the site build was stamped with, not a sha
 * read afterwards, so `scripts/canary/build-probe.ts` can hold the deployment
 * to the claim.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { WORKER_IDENTITY } from "../src/workerIdentity"

const dryRun = process.argv.includes("--dry-run")

const serverDir = fileURLToPath(new URL("..", import.meta.url))
const uiDir = fileURLToPath(new URL("../../app", import.meta.url))
const siteDir = fileURLToPath(new URL("../../site", import.meta.url))
/** The Alchemy CLI, invoked the one way that resolves this package's imports (see the header). */
const alchemy = (...args: ReadonlyArray<string>): ReadonlyArray<string> => [
  "bun",
  `${serverDir}node_modules/alchemy/bin/alchemy.ts`,
  ...args
]

const run = async (
  cmd: ReadonlyArray<string>,
  options: { cwd: string; capture?: boolean; env?: Record<string, string> }
): Promise<{ exitCode: number; output: string }> => {
  const proc = Bun.spawn([...cmd], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdout: options.capture === true ? "pipe" : "inherit",
    stderr: "inherit"
  })
  const output = options.capture === true ? await new Response(proc.stdout).text() : ""
  if (options.capture === true) process.stdout.write(output)
  const exitCode = await proc.exited
  return { exitCode, output }
}

/*
 * The sha is read BEFORE the build, not after, because the build consumes it:
 * the site's build-stamp integration (apps/site/scripts/build-stamp-integration.ts,
 * over apps/app/scripts/build-stamp.ts) writes SMITHERS_BUILD_SHA into the
 * build as /__build.json and as a meta tag on the app document. The receipt
 * below records the same value, so the deployment and the receipt can be
 * compared byte for byte; that comparison is CN-1, and
 * scripts/canary/build-probe.ts runs it. The same value is exported to the
 * Alchemy run so the Worker's `SMITHERS_BUILD_SHA` binding names the build.
 *
 * A dirty tree is recorded rather than hidden. The sha alone would claim the
 * artifact is that commit, which is not true when uncommitted work went into
 * the build.
 */
const gitSha = (await run(["git", "rev-parse", "HEAD"], { cwd: serverDir, capture: true })).output.trim()
const gitDirty = (await run(["git", "status", "--porcelain"], { cwd: serverDir, capture: true })).output.trim() !== ""

/*
 * The island's sources are transformed under apps/app/tsconfig.json, which
 * extends the projected Electrobun devkit (gitignored), so a fresh checkout
 * cannot build the site until that projection exists. apps/app's own build ran
 * this step first; the site build does not, so it runs here.
 */
console.log(`[deploy] ensuring the Electrobun devkit projection in ${uiDir}...`)
const devkit = await run(["node", "scripts/ensure-devkit.mjs"], { cwd: uiDir })
if (devkit.exitCode !== 0) {
  console.error("[deploy] the devkit projection could not be prepared.")
  process.exit(devkit.exitCode)
}

console.log(`[deploy] building the smithers.sh site in ${siteDir}, stamped ${gitSha}${gitDirty ? " (dirty tree)" : ""}...`)
const build = await run(["pnpm", "run", "build"], { cwd: siteDir, env: { SMITHERS_BUILD_SHA: gitSha } })
if (build.exitCode !== 0) {
  console.error("[deploy] site build failed.")
  process.exit(build.exitCode)
}

const apiToken = process.env.CLOUDFLARE_API_TOKEN
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? WORKER_IDENTITY.accountId
const alchemyEnv = { SMITHERS_BUILD_SHA: gitSha, CLOUDFLARE_ACCOUNT_ID: accountId }
const stageArgs = ["--stage", WORKER_IDENTITY.stage]

/**
 * What the dry run proved. `alchemy plan` evaluates the stack: it loads
 * src/Worker.ts, runs the init closure (registering the five Durable Object
 * exports and reading every `Config` present in this shell) and prints the
 * resources and bindings it would reconcile. It needs no Cloudflare
 * credential, because it does not read the live script — the live read, and
 * therefore the adoption, happens during apply. So a green plan proves the
 * program and its declared identity, never that the adopting deploy is safe:
 * that is scripts/adopt-durable-objects.ts's job, and the real deploy below
 * runs it first.
 */
let dryRunMode: "plan" | null = null

if (dryRun) {
  console.log(`[deploy] dry-run: alchemy plan ${stageArgs.join(" ")} (evaluates the stack, reads no live script, publishes nothing)...`)
  const plan = await run(alchemy("plan", ...stageArgs), { cwd: serverDir, env: alchemyEnv })
  if (plan.exitCode !== 0) {
    console.error("[deploy] alchemy plan failed.")
    process.exit(plan.exitCode)
  }
  dryRunMode = "plan"
  console.log("[deploy] the plan does not read the live script; run `bun scripts/adopt-durable-objects.ts` for the adoption verdict.")
} else {
  if (apiToken === undefined || apiToken === "") {
    console.error("[deploy] CLOUDFLARE_API_TOKEN is unset; a real deploy needs it (see DEPLOY.md).")
    process.exit(1)
  }
  console.log("[deploy] adoption preflight (scripts/adopt-durable-objects.ts)...")
  const preflight = await run(["bun", "scripts/adopt-durable-objects.ts"], { cwd: serverDir, env: alchemyEnv })
  if (preflight.exitCode !== 0) {
    console.error("[deploy] the preflight is red; not deploying. A Durable Object mismatch on an adopting deploy is data loss.")
    process.exit(preflight.exitCode)
  }
  console.log(`[deploy] alchemy deploy ${stageArgs.join(" ")} --adopt --yes ...`)
  const deploy = await run(alchemy("deploy", ...stageArgs, "--adopt", "--yes"), { cwd: serverDir, env: alchemyEnv })
  if (deploy.exitCode !== 0) {
    console.error("[deploy] alchemy deploy failed.")
    process.exit(deploy.exitCode)
  }
}

/*
 * Alchemy prints no version id for a full-cutover deploy (it records one only
 * for gradual rollouts), so the id is read back from the deployments list,
 * the same read scripts/canary/rollback-probe.ts performs. A real deploy that
 * leaves no readable id gives CN-24 a receipt it cannot use: rollback-probe.ts
 * needs the id to assert that the previous version is reachable and that the
 * deployment matches the receipt. Writing `null` and carrying on would hand
 * the operator a rollback plan that silently verifies nothing. Fail here
 * instead, while the deploy output is still on screen. A dry run legitimately
 * has no id, so it is exempt.
 */
const readDeployedVersionId = async (): Promise<string | null> => {
  const base = process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4"
  const response = await fetch(`${base}/accounts/${accountId}/workers/scripts/${WORKER_IDENTITY.name}/deployments`, {
    headers: { authorization: `Bearer ${apiToken}` }
  })
  if (!response.ok) return null
  const body = (await response.json()) as { result?: { deployments?: ReadonlyArray<{ versions?: ReadonlyArray<{ version_id?: string; percentage?: number }> }> } }
  const versions = body.result?.deployments?.[0]?.versions ?? []
  const live = [...versions].sort((a, b) => (b.percentage ?? 0) - (a.percentage ?? 0))[0]
  return live?.version_id ?? null
}

const versionId = dryRun ? null : await readDeployedVersionId()
if (!dryRun && versionId === null) {
  console.error("[deploy] alchemy deployed but the deployments list names no version id.")
  console.error("[deploy] The receipt would carry wranglerVersionId: null, which CN-24 cannot verify.")
  console.error("[deploy] Check the account with `bun scripts/canary/rollback-probe.ts`, then re-run, or record the id by hand.")
  process.exit(1)
}

/*
 * `wranglerVersionId` keeps its name: scripts/canary/rollback-verdict.ts
 * reads that key, and the value is the same Cloudflare version id Wrangler
 * used to print. `deployTool` and `dryRunMode` say which tool produced it.
 */
const receipt = {
  worker: WORKER_IDENTITY.name,
  dryRun,
  dryRunMode,
  deployTool: "alchemy",
  gitSha,
  gitDirty,
  timestamp: new Date().toISOString(),
  wranglerVersionId: versionId
}

const receiptDir = dryRun ? `${serverDir}deploy-receipts/dry-run` : `${serverDir}deploy-receipts`
mkdirSync(receiptDir, { recursive: true })
const receiptPath = `${receiptDir}/${receipt.timestamp.replace(/[:.]/g, "-")}.json`
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, "\t")}\n`)
writeFileSync(`${receiptDir}/latest.json`, `${JSON.stringify(receipt, null, "\t")}\n`)

console.log(`[deploy] receipt written to ${receiptPath}`)
if (!dryRun) {
  console.log(
    `[deploy] verify the deployment serves what this receipt claims:\n` +
      `         bun scripts/canary/build-probe.ts https://canary.smithers.sh --sha ${gitSha}`
  )
}
