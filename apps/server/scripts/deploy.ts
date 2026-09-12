/**
 * Scripted deploy: build the smithers.sh Astro site (apps/site), which carries
 * the product app as a prerendered React island, then deploy this package's
 * Worker with `wrangler deploy` over wrangler.jsonc, recording a receipt (git
 * sha + timestamp + Cloudflare version id) either way.
 *
 *   bun scripts/deploy.ts --dry-run
 *     Runs the real site build, then `wrangler deploy --dry-run`, which
 *     bundles src/index.ts, reads the assets directory and prints the
 *     bindings it would upload without touching the account. Nothing is
 *     published. Receipt lands in deploy-receipts/dry-run/.
 *
 *   bun scripts/deploy.ts
 *     Real deploy. Requires CLOUDFLARE_API_TOKEN; CLOUDFLARE_ACCOUNT_ID
 *     defaults to the frozen account. Runs scripts/adopt-durable-objects.ts
 *     first and stops on a red report, then `wrangler deploy`. Receipt lands
 *     in deploy-receipts/.
 *
 * The Worker identity (name `smithers-mvp-web`, the canary.smithers.sh domain,
 * the apex route, the five Durable Objects) is frozen in src/workerIdentity.ts
 * and held to wrangler.jsonc by src/workerIdentity.test.ts; see
 * apps/server/DEPLOY.md. This script never changes it; it only builds and
 * deploys what's there.
 *
 * SECRETS ARE NOT AN INPUT. wrangler uploads with `keep_bindings:
 * ["secret_text"]`, so every secret set once with `wrangler secret put` stays
 * on the script across deploys, and this shell never has to carry a value.
 * The deploy path before this one (Alchemy, 2026-09-10 to 2026-09-12) replaced
 * the bindings wholesale and so could not run without all eleven values in
 * the shell, which nobody had; it never deployed.
 *
 * CN-1: the receipt records the sha the site build was stamped with, not a sha
 * read afterwards, so `scripts/canary/build-probe.ts` can hold the deployment
 * to the claim.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { WORKER_IDENTITY } from "../src/workerIdentity"

const dryRun = process.argv.includes("--dry-run")

const serverDir = fileURLToPath(new URL("..", import.meta.url))
const uiDir = fileURLToPath(new URL("../../app", import.meta.url))
const siteDir = fileURLToPath(new URL("../../site", import.meta.url))
/**
 * This package's own wrangler (a devDependency, so the version is the
 * lockfile's), on its JavaScript entry: no shell shim, no PATH lookup, and
 * the same binary under pnpm, bun and CI.
 */
const wrangler = (...args: ReadonlyArray<string>): ReadonlyArray<string> => [
  "node",
  `${serverDir}node_modules/wrangler/bin/wrangler.js`,
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
 * below records the sha read back from that file, so the deployment and the
 * receipt can be compared byte for byte; that comparison is CN-1, and
 * scripts/canary/build-probe.ts runs it.
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

/*
 * The stamp the build actually wrote is what the deployment will serve, so
 * the receipt reads it back instead of trusting the value it passed in. A
 * build that stamped something else (a stale dist, an integration that
 * stopped running) is caught here, before it is published as this commit.
 */
const stamp = JSON.parse(readFileSync(join(serverDir, WORKER_IDENTITY.assets.directory, "__build.json"), "utf8")) as {
  gitSha?: string
}
if (stamp.gitSha !== gitSha) {
  console.error(`[deploy] the site build is stamped ${stamp.gitSha ?? "<none>"}, not ${gitSha}; not deploying a build that names another commit.`)
  process.exit(1)
}

const apiToken = process.env.CLOUDFLARE_API_TOKEN
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? WORKER_IDENTITY.accountId
const wranglerEnv = { CLOUDFLARE_ACCOUNT_ID: accountId }

let versionId: string | null = null

if (dryRun) {
  const outdir = mkdtempSync(join(tmpdir(), "smithers-mvp-web-dry-run-"))
  console.log(`[deploy] dry-run: wrangler deploy --dry-run --outdir ${outdir} (bundles the Worker, reads the assets, publishes nothing)...`)
  const plan = await run(wrangler("deploy", "--dry-run", "--outdir", outdir), { cwd: serverDir, env: wranglerEnv })
  if (plan.exitCode !== 0) {
    console.error("[deploy] wrangler deploy --dry-run failed.")
    process.exit(plan.exitCode)
  }
  console.log("[deploy] the dry run reads no live script; run `bun scripts/adopt-durable-objects.ts` for the identity verdict.")
} else {
  if (apiToken === undefined || apiToken === "") {
    console.error("[deploy] CLOUDFLARE_API_TOKEN is unset; a real deploy needs it (see DEPLOY.md).")
    process.exit(1)
  }
  console.log("[deploy] identity preflight (scripts/adopt-durable-objects.ts)...")
  const preflight = await run(["bun", "scripts/adopt-durable-objects.ts"], { cwd: serverDir, env: wranglerEnv })
  if (preflight.exitCode !== 0) {
    console.error("[deploy] the preflight is red; not deploying. A Durable Object mismatch is data loss.")
    process.exit(preflight.exitCode)
  }
  console.log("[deploy] wrangler deploy ...")
  const deploy = await run(wrangler("deploy"), { cwd: serverDir, env: wranglerEnv, capture: true })
  if (deploy.exitCode !== 0) {
    console.error("[deploy] wrangler deploy failed.")
    process.exit(deploy.exitCode)
  }
  /*
   * wrangler prints the id of the version it just made live. A real deploy
   * that leaves no readable id gives CN-24 a receipt it cannot use:
   * rollback-probe.ts needs the id to assert that the previous version is
   * reachable and that the deployment matches the receipt. Writing `null`
   * and carrying on would hand the operator a rollback plan that silently
   * verifies nothing. Fail here instead, while the deploy output is still on
   * screen.
   */
  versionId = deploy.output.match(/Current Version ID:\s*([0-9a-f-]{36})/)?.[1] ?? null
  if (versionId === null) {
    console.error("[deploy] wrangler deployed but printed no `Current Version ID`.")
    console.error("[deploy] The receipt would carry wranglerVersionId: null, which CN-24 cannot verify.")
    console.error("[deploy] Check the account with `bun scripts/canary/rollback-probe.ts`, then re-run, or record the id by hand.")
    process.exit(1)
  }
}

/*
 * `wranglerVersionId` is the key scripts/canary/rollback-verdict.ts reads.
 * `dryRunMode` names what a dry run proved (a bundle, never a live read).
 */
const receipt = {
  worker: WORKER_IDENTITY.name,
  dryRun,
  dryRunMode: dryRun ? "bundle" : null,
  deployTool: "wrangler",
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
