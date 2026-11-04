#!/usr/bin/env node
// The e2e suite against production (docs/infrastructure.md#against-a-deployment):
//
//   E2E_PROD_URL=<the production deployment's URL> pnpm e2e:prod [spec…] [playwright options…]
//
// It runs Playwright with E2E_TARGET=deployment (e2e/target.ts): the setup signs the test account in or reuses its
// session, every spec runs or skips by its declared needs, and the summary (e2e/summary.ts) prints each spec's results
// and fails the run on a failure, an undeclared skip or a blocked need. Then it makes the run's videos and GIFs, apart
// from a local run's, and exits with Playwright's status, or the recordings' when only they failed.
//
// One run at a time uses the test account on a deployment: the run holds a lock directory, `E2E_PROD_LOCK` or
// `run.lock` beside the stored session, with an `owner` file saying who holds it, and waits while another run does.
// A lock whose owner process has ended is reported, never taken over. The lock is released as soon as Playwright exits,
// before the recordings are made.
//
// The run's settings, the E2E_* variables naming its scratch repositories, mirror and keys, come from `e2e.env` beside
// the stored session (e2e/settings.ts), private to its owner; a variable the environment sets wins.
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { settingsFileOf, withSettings } from "./settings.ts"
import { assertShipPrerequisites, shipAcceptance, shipInventory, shipListingDiagnostics } from "./ship.ts"

const url = process.env.E2E_PROD_URL ?? ""
if (!/^https:\/\//.test(url)) {
  console.error("Set E2E_PROD_URL to the production deployment's https URL; its deployment details live outside this repository.")
  process.exit(2)
}

const settingsFile = settingsFileOf(url)
let settings
try {
  settings = withSettings(process.env, settingsFile)
  assertShipPrerequisites(settings.env, process.argv.slice(2))
} catch (error) {
  console.error(error.message)
  process.exit(2)
}
if (settings.set.length > 0) console.error(`Settings from ${settingsFile}: ${settings.set.join(", ")}`)

const env = { ...settings.env, E2E_TARGET: "deployment", BASE_URL: url }
if (shipAcceptance(env)) {
  const listing = spawnSync("pnpm", ["exec", "playwright", "test", "--list", "--reporter=json"], {
    env: { ...env, E2E_SHIP_ACCEPTANCE: "0", E2E_SHIP_COLLECT: "1" }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  })
  if (listing.status !== 0) {
    console.error(`Ship acceptance could not collect the full test inventory (exit ${listing.status ?? "unknown"}); no tests started`)
    const diagnostic = shipListingDiagnostics(listing.stderr ?? "", listing.stdout ?? "", env)
    if (diagnostic !== "") console.error(diagnostic)
    process.exit(2)
  }
  try {
    const inventory = shipInventory(JSON.parse(listing.stdout))
    if (inventory.length === 0) throw new Error("empty inventory")
    const dir = mkdtempSync(join(tmpdir(), "smithers-ship-"))
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }))
    env.E2E_SHIP_INVENTORY = join(dir, "inventory.json")
    writeFileSync(env.E2E_SHIP_INVENTORY, JSON.stringify(inventory), { mode: 0o600 })
  } catch {
    console.error("Ship acceptance could not retain the full test inventory; no tests started")
    process.exit(2)
  }
}

const lock = settings.env.E2E_PROD_LOCK ?? join(settings.env.E2E_SESSION_DIR ?? join(homedir(), ".smithers-e2e"), new URL(url).host, "run.lock")
const ownerOf = () => {
  try {
    return readFileSync(join(lock, "owner"), "utf8").trim()
  } catch {
    return "an unnamed run"
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}
const take = () => {
  try {
    mkdirSync(lock)
  } catch (error) {
    if (error.code === "EEXIST") return false
    throw error
  }
  writeFileSync(join(lock, "owner"), `pnpm e2e:prod, pid ${process.pid}, in ${process.cwd()}, since ${new Date().toISOString()}\n`)
  return true
}
mkdirSync(dirname(lock), { recursive: true })
for (let previous = ""; !take();) {
  const owner = ownerOf()
  const pid = Number(/\bpid (\d+)/.exec(owner)?.[1])
  if (Number.isInteger(pid) && !alive(pid)) {
    console.error(`The production e2e lock ${lock} is held by a run that ended (${owner}). Remove it once nothing uses the test account.`)
    process.exit(2)
  }
  if (previous !== owner) console.error(`Waiting for the production e2e lock ${lock}, held by: ${owner}`)
  previous = owner
  // A blocking wait between looks; the lock is a directory another process removes.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000)
}
// Released once: after Playwright exits, or at exit when it never ran. A second release would remove the next run's lock.
let held = true
const release = () => {
  if (!held) return
  held = false
  rmSync(lock, { recursive: true, force: true })
}
process.on("exit", release)
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(130))

const tests = spawnSync("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], { stdio: "inherit", env })
// The recordings use neither the test account nor the deployment: the next run may start while they are made.
release()
const media = join(homedir(), "Desktop/smithers-mvp/prod")
// A small browser driver can delegate video encoding to its compute host. The runner must wait for the real
// media command and propagate its exit status; the recordings remain part of this run's gate.
const recordings = spawnSync(env.E2E_MEDIA_RUNNER || "node", ["e2e/gifs.mjs", "test-results-deployment", join(media, "gifs"), join(media, "videos")], { stdio: "inherit", env })
process.exit(tests.status !== 0 ? (tests.status ?? 1) : (recordings.status ?? 1))
