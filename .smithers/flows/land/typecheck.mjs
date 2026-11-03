/** The typecheck a land owes apps/mvp, run on the farm: no local install, while the FIFO landing lease is held. */
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { jj } from "./numbering.mjs"
import { runProcess } from "./process.mjs"
import { cfboxClient, runCfbox, withTrackedTree } from "./cfbox.mjs"

const budgetMs = 20 * 60 * 1000
const receipt = /^SMITHERS_TYPECHECK_EXIT=(\d+)$/m
// The receipt is the command's own: a farm client that skips a package still exits 0, and prints no receipt.
// Spaces around "typecheck" let lat-remote.sh classify it as light, so it needs no heavy-test permit.
export const command = 'pnpm typecheck ; echo "SMITHERS_TYPECHECK_EXIT=$?"'

const clients = () => [
  process.env.SMITHERS_MINI_RUN ?? join(homedir(), ".smithers-lead/scratchpad-mirror/mini-run"),
  process.env.SMITHERS_LAT_RUN ?? join(homedir(), ".smithers-lead/lat-run"),
  cfboxClient()
]

/**
 * A client's output goes to a file: lat-run does not survive writing to a pipe. Five seconds of admission by default:
 * mini-run before 2026-11-03 checked its deadline before its first slot sweep, so 0 skipped even an idle mini.
 */
export const runClient = async (client, root, signal, { directory = "apps/mvp", argv = ["sh", "-c", command], timeoutMs = budgetMs, source = root, waitSeconds = 5, env = {}, lifecycle = () => ({}) } = {}) => {
  const scratch = mkdtempSync(join(tmpdir(), "smithers-farm-"))
  const log = join(scratch, "output.log")
  closeSync(openSync(log, "a", 0o600))
  try {
    const result = await runProcess("bash", ["-c", 'log=$1; shift; exec "$@" >"$log" 2>&1', "farm", log, client, directory, "--", ...argv], {
      cwd: root, signal, timeoutMs: timeoutMs + waitSeconds * 1000, ...lifecycle(log),
      // mini-run and lat-run kill a run at their own deadline, 40 minutes by default, counted from admission; the caller's
      // budget is that deadline, and the wait for admission comes on top.
      env: { ...process.env, ...env, MINI_RUN_SRC: source, LAT_RUN_SRC: source, MINI_RUN_WAIT_SECONDS: String(waitSeconds), MINI_RUN_TIMEOUT_SECONDS: String(Math.ceil(timeoutMs / 1000)),
        LAT_RUN_WAIT_SECONDS: String(waitSeconds), LAT_RUN_TIMEOUT_SECONDS: String(Math.ceil(timeoutMs / 1000)) }
    })
    return { status: result.status, output: readFileSync(log, "utf8") }
  } catch (error) {
    if (signal?.aborted) throw error
    return { status: null, output: `${error.message}\n${readFileSync(log, "utf8")}` }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

export const farmClients = () => clients()
/** Each farm client with the platform its hosts run: the mini is a Mac, Latitude is Linux. */
export const farmHosts = () => clients().slice(0, 2).map((client, i) => ({ client, kind: i === 0 ? "mini" : "latitude", platform: i === 0 ? "darwin" : "linux" }))

export const tail = (text) => text.trimEnd().split("\n").slice(-40).join("\n")

const runBox = async (box, root, signal) => {
  try {
    return await withTrackedTree(root, "smithers-typecheck-source-", async (tree) => {
      const nodeVersion = readFileSync(join(root, ".node-version"), "utf8").trim()
      // Reuse verified Node and pinned pnpm setup. Its CI install skips scripts;
      // the normal install must succeed before typecheck may emit its receipt.
      const result = await runCfbox(root, tree, ["bash", "-c", `source .github/scripts/ci/cloud.sh; ensure_js; pnpm install --frozen-lockfile; cd apps/mvp; set +e; ${command}`], {
        box, signal, cpu: "4", cacheKey: `typecheck-node-${nodeVersion}`, timeoutMs: budgetMs
      })
      return { status: result.status, output: result.stdout + "\n" + result.stderr }
    })
  } catch (error) {
    if (signal?.aborted) throw error
    return { status: null, output: error.message }
  }
}

/**
 * Refuses unless every apps/mvp project typechecks. A land that doesn't touch apps/mvp needs none. A farm that
 * can't answer refuses too, naming each client's result: a skipped check would look the same as a passed one.
 */
export async function typecheckApp(root, {
  signal,
  touched = () => jj(root, ["diff", "--ignore-working-copy", "--from", "main@origin", "--to", "@", "--name-only", "apps/mvp"]).trim() !== "",
  source = () => jj(root, ["log", "--ignore-working-copy", "-r", "@", "--no-graph", "-T", "commit_id"])
} = {}) {
  if (!touched()) return undefined
  const before = source()
  const tried = []
  for (const [index, client] of clients().entries()) {
    console.error(`TYPECHECK apps/mvp on ${client}`)
    const started = Date.now()
    const { status, output } = await (index === 2 ? runBox : runClient)(client, root, signal)
    const answered = output.match(receipt)
    if (!answered || (status !== 0 && answered[1] === "0")) {
      tried.push(`${client}: exit ${status}, ${answered ? "incomplete typecheck transport" : "no typecheck receipt"}${/\bCAPACITY_TIMEOUT\b/.test(output) ? " (no capacity)" : ""}\n${tail(output)}`)
      continue
    }
    if (source() !== before) throw new Error("Source changed during the farm typecheck; rerun land")
    if (answered[1] !== "0") throw new Error(`apps/mvp does not typecheck; nothing pushed. pnpm typecheck exited ${answered[1]} on ${client}:\n${tail(output)}`)
    console.error(`TYPECHECK passed on ${client} in ${Math.round((Date.now() - started) / 1000)} s`)
    return client
  }
  throw new Error(`Cannot typecheck apps/mvp: no farm client answered, so the land refuses; nothing pushed. Rerun when the farm has capacity.\n${tried.join("\n")}`)
}
