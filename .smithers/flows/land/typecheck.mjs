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
 * A client's output goes to a file: lat-run does not survive writing to a pipe. Five seconds of admission:
 * mini-run before 2026-11-03 checked its deadline before its first slot sweep, so 0 skipped even an idle mini.
 */
const runClient = async (client, root, signal) => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-typecheck-"))
  const log = join(directory, "output.log")
  const output = openSync(log, "a", 0o600)
  closeSync(output)
  try {
    const result = await runProcess("bash", ["-c", 'log=$1; shift; exec "$@" >"$log" 2>&1', "typecheck", log, client, "apps/mvp", "--", "sh", "-c", command], {
      cwd: root, signal, timeoutMs: budgetMs,
      env: { ...process.env, MINI_RUN_SRC: root, LAT_RUN_SRC: root, MINI_RUN_WAIT_SECONDS: "5" }
    })
    return { status: result.status, output: readFileSync(log, "utf8") }
  } catch (error) {
    if (signal?.aborted) throw error
    return { status: null, output: `${error.message}\n${readFileSync(log, "utf8")}` }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

const tail = (text) => text.trimEnd().split("\n").slice(-40).join("\n")

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
