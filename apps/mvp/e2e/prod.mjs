#!/usr/bin/env node
// Production boundary: exact Playwright discovery -> resource leases -> isolated setup/specs -> media.
import "vibelang/register"
import { runChild } from "./child-runner.ts"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { settingsFileOf, sessionDirOf, withSettings } from "./settings.ts"
import { declarations, filesFromList, parseListReport, resourcesFor } from "./resources.ts"
import { ResourceLocks, releaseAll } from "./resource-locks.ts"
import { assertShipPrerequisites, shipAcceptance, shipInventory, shipListingDiagnostics } from "./ship.ts"
import { joinLegacyFence, whileLeavingFence } from "./legacy-fence.ts"
const { PoolUnavailable, ensureScratchRepository, leaseRunResources, poolConfig, poolNames, scratchGitHubLive, verifyPoolAccount } = await import("./scratch-pool.ts")

const abort = new AbortController()
let stopping = false
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {
  stopping = true
  abort.abort()
})
const run = (command, args, env, capture = false) => runChild(command, args, { env, capture, signal: abort.signal, log: console.error })

async function main() {
  const url = process.env.E2E_PROD_URL ?? ""
  if (!/^https:\/\//.test(url)) throw new Error("Set E2E_PROD_URL to the production deployment's https URL")
  const settingsFile = settingsFileOf(url)
  const settings = withSettings(process.env, settingsFile)
  if (settings.set.length) console.error(`Settings from ${settingsFile}: ${settings.set.join(", ")}`)
  const args = process.argv.slice(2)
  assertShipPrerequisites(settings.env, args)
  if (args.some((arg) => ["--no-deps", "--config", "-c", "--output"].includes(arg) || arg.startsWith("--config=") || arg.startsWith("--output=") || /^-c.+/.test(arg))) {
    throw new Error("Production e2e requires its deployment config and isolated setup/output; --no-deps, --config and --output are not supported")
  }
  const root = sessionDirOf(url, settings.env)
  await mkdir(join(root, "runs"), { recursive: true, mode: 0o700 })
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const runDir = await mkdtemp(join(root, "runs", `${runId}-`))
  const outputDir = resolve("test-results-deployment", runId)
  const env = { ...settings.env, E2E_TARGET: "deployment", BASE_URL: url, E2E_RUN_ID: runId,
    E2E_RUN_DIR: runDir, E2E_OUTPUT_DIR: outputDir }
  // Never let the discovery reporter overwrite a user's real report file.
  delete env.PLAYWRIGHT_JSON_OUTPUT_FILE
  delete env.PLAYWRIGHT_JSON_OUTPUT_NAME
  delete env.PLAYWRIGHT_JSON_OUTPUT_DIR
  let leases = []
  let leaveFence
  try {
    if (shipAcceptance(env)) {
      const listing = await run("pnpm", ["exec", "playwright", "test", "--list", "--reporter=json"],
        { ...env, E2E_SHIP_ACCEPTANCE: "0", E2E_SHIP_COLLECT: "1" }, true)
      if (listing.status !== 0) {
        const diagnostic = shipListingDiagnostics(listing.stderr, listing.stdout, env)
        throw new Error(`Ship acceptance could not collect the full test inventory (exit ${listing.status}); no tests started${diagnostic ? `\n${diagnostic}` : ""}`)
      }
      const inventory = shipInventory(parseListReport(listing.stdout))
      if (inventory.length === 0) throw new Error("Ship acceptance collected an empty inventory; no tests started")
      env.E2E_SHIP_INVENTORY = join(runDir, "ship-inventory.json")
      await writeFile(env.E2E_SHIP_INVENTORY, JSON.stringify(inventory), { mode: 0o600 })
    }
    const listed = await run("pnpm", ["exec", "playwright", "test", ...args, "--list", "--reporter=json"], env, true)
    if (listed.status !== 0) throw new Error(`Playwright discovery failed: ${shipListingDiagnostics(listed.stderr, listed.stdout, env)}`)
    const selected = filesFromList(parseListReport(listed.stdout))
    if (!selected.some((file) => file.endsWith(".spec.ts"))) throw new Error("Playwright selected no tests")
    const declared = declarations(selected)
    if (args.includes("--list")) { console.log(selected.join("\n")); return 0 }
    console.error(`[e2e-run] ${runId} selected=${selected.join(",")} resources=${declared.join(",") || "none"}`)
    const locks = new ResourceLocks(join(root, "resource-locks"), { log: console.error, signal: abort.signal })
    leaveFence = await joinLegacyFence(settings.env.E2E_PROD_LOCK ?? join(root, "run.lock"), locks)
    const kinds = ["stack", "factory"].filter((kind) => declared.includes(kind))
    let config
    let github
    let poolStage = "configuration"
    if (kinds.length && env.E2E_SCRATCH_POOL !== "off") {
      try {
        config = poolConfig(env)
        poolStage = "test-account-token"
        if (!env.E2E_GITHUB_TOKEN) throw new Error("test account token unavailable")
        github = scratchGitHubLive(env.E2E_GITHUB_TOKEN)
        poolStage = "installation-verification"
        const installation = await Effect.runPromise(verifyPoolAccount(config).pipe(Effect.provide(github)), { signal: abort.signal })
        console.error(`[e2e-pool] verified installation=${installation} repository_selection=all`)
      } catch (error) {
        abort.signal.throwIfAborted()
        if (poolStage === "configuration" && !(error instanceof PoolUnavailable)) throw error
        console.error(`[e2e-pool] fallback stage=${poolStage}: test-account credential or active all-repositories App installation could not be verified`)
        config = undefined
      }
    }
    if (config) {
      const fixed = (repositories) => resourcesFor(declared, {
        ...env, ...Object.fromEntries(kinds.map((kind, index) => [`E2E_${kind.toUpperCase()}_REPOSITORY`, repositories[index]])),
      })
      const acquired = await leaseRunResources(locks, fixed, kinds.map((kind) => poolNames(config, kind)))
      leases = acquired.leases
      try {
        for (let i = 0; i < kinds.length; i++) {
          const repository = acquired.repositories[i]
          poolStage = `${kinds[i]}-repository`
          await Effect.runPromise(ensureScratchRepository(repository, config).pipe(Effect.provide(github)), { signal: abort.signal })
          env[`E2E_${kinds[i].toUpperCase()}_REPOSITORY`] = repository
          console.error(`[e2e-pool] leased ${kinds[i]}=${repository}`)
        }
        // External runners need their own public clone; never retarget a shared configured mirror.
        if (kinds.includes("factory") && selected.some((name) => /(?:agent-runner|todos-independent|fleet)\.spec\.ts$/.test(name))) {
          poolStage = "factory-mirror"
          const mirror = join(runDir, "factory-mirror")
          const cloned = await run("jj", ["git", "clone", `https://github.com/${env.E2E_FACTORY_REPOSITORY}.git`, mirror], env)
          if (cloned.status !== 0) throw new Error("Scratch mirror clone failed")
          env.E2E_RUNNER_MIRROR = mirror
        }
      } catch {
        abort.signal.throwIfAborted()
        await releaseAll(leases); leases = []
        for (const kind of kinds) env[`E2E_${kind.toUpperCase()}_REPOSITORY`] = settings.env[`E2E_${kind.toUpperCase()}_REPOSITORY`]
        env.E2E_RUNNER_MIRROR = settings.env.E2E_RUNNER_MIRROR
        config = undefined
        console.error(`[e2e-pool] fallback stage=${poolStage}: provisioning failed; configured repositories will be locked`)
      }
    }
    if (!config) leases = (await leaseRunResources(locks, resourcesFor(declared, env), [])).leases
    // Verify under the final model read lease, and keep it through Playwright. A missing fixture releases
    // ALL resources before taking the writer, then reacquires in global order and checks again.
    if (declared.includes("model:read") && !declared.includes("model:write") && env.E2E_PERSONAL_MODEL_KEY) {
      const prepare = async (access) => {
        const result = await run("pnpm", ["exec", "playwright", "test", "deployment/sign-in.setup.ts", "--project=deployment-auth", "--grep", "sign in as the test account|personal model:"],
          { ...env, E2E_SHIP_ACCEPTANCE: "0", E2E_MODEL_ACCESS: access, E2E_OUTPUT_DIR: `${outputDir}-model-${access}` })
        if (result.status !== 0) throw new Error(`Personal model ${access} failed before test execution`)
      }
      for (;;) {
        await prepare("probe")
        if (JSON.parse(await readFile(join(runDir, "model-ready.json"), "utf8")) === true) break
        await releaseAll(leases); leases = []
        const writer = await locks.acquire({ name: "account:model-connections", mode: "write" })
        try { await prepare("bootstrap") } finally { await writer.release() }
        leases = (await leaseRunResources(locks, resourcesFor(declared, env), [])).leases
      }
    }
    env.E2E_CLEAN_REPOSITORIES = JSON.stringify([...new Set(kinds.map((kind) => env[`E2E_${kind.toUpperCase()}_REPOSITORY`]).filter(Boolean))])
    env.E2E_MODEL_ACCESS = declared.includes("model:write") ? "write" : declared.includes("model:read") ? "read" : "none"
    console.error(`[e2e-run] ${new Date().toISOString()} ${runId} playwright-start output=${outputDir}`)
    const tests = await run("pnpm", ["exec", "playwright", "test", ...args], env)
    console.error(`[e2e-run] ${new Date().toISOString()} ${runId} playwright-exit status=${tests.status}`)
    await releaseAll(leases); leases = []
    const finishFence = leaveFence; leaveFence = undefined
    const media = join(homedir(), "Desktop/smithers-mvp/prod", runId)
    const recordings = await whileLeavingFence(finishFence, () => stopping ? Promise.resolve({ status: 130 }) :
      run(env.E2E_MEDIA_RUNNER || "node", ["e2e/gifs.mjs", outputDir, join(media, "gifs"), join(media, "videos")], env))
    return tests.status !== 0 ? tests.status : recordings.status
  } finally {
    // Private snapshots are removed even when lock/fence cleanup reports a failure.
    const cleanup = await Promise.allSettled([
      rm(runDir, { recursive: true, force: true }), releaseAll(leases), ...(leaveFence ? [leaveFence()] : []),
    ])
    const failed = cleanup.filter((result) => result.status === "rejected")
    if (failed.length) throw new AggregateError(failed.map((result) => result.reason), "Production e2e cleanup failed; inspect owned locks")
  }
}
try { process.exitCode = await main() }
catch (error) {
  // Provider calls are caught at their boundary; this contains only runner/config/filesystem diagnostics.
  console.error(stopping ? "Production e2e interrupted; child exited before leases were released" : error.message)
  process.exitCode = stopping ? 130 : 2
}
