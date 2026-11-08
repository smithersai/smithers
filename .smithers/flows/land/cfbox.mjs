/** Source-only cfbox execution for bootstrap land checks, without a local install. */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { sourcePath } from "./files.mjs"
import { jj } from "./numbering.mjs"
import { runProcess } from "./process.mjs"

export const cfboxClient = () => process.env.SMITHERS_CFBOX ?? join(homedir(), ".vibe-orch/bin/cfbox")

/** Supply cfbox's directory walker only jj-listed source, never VCS storage or ignored files. */
export async function withTrackedTree(root, prefix, body) {
  const tree = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  try {
    for (const path of jj(root, ["file", "list"]).split("\n").filter(Boolean)) {
      const source = sourcePath(root, path, true)
      mkdirSync(dirname(join(tree, path)), { recursive: true })
      cpSync(source, join(tree, path), { dereference: false, verbatimSymlinks: true, preserveTimestamps: true })
    }
    return await body(tree)
  } finally { rmSync(tree, { recursive: true, force: true }) }
}

const relayHost = () => {
  if (process.env.SMITHERS_CFBOX_RELAY) return process.env.SMITHERS_CFBOX_RELAY
  const client = process.env.SMITHERS_LAT_RUN ?? join(homedir(), ".smithers-lead/lat-run")
  let config
  try { config = JSON.parse(readFileSync(join(dirname(client), "farm-config.json"), "utf8")) }
  catch (error) {
    if (error.code === "ENOENT") return undefined
    throw new Error("Cannot read private farm relay configuration")
  }
  const endpoints = config.latEndpoints
  if (!endpoints || typeof endpoints !== "object" || Array.isArray(endpoints)) return undefined
  return Object.values(endpoints).find((host) => typeof host === "string" && /^[A-Za-z0-9_.@:-]+$/.test(host))
}

/** Retry only a direct pre-command upload failure, once; a relayed upload cannot use cfbox's cache. */
export async function runCfbox(root, tree, command, { box = cfboxClient(), signal, cpu = "2", cacheKey, timeoutMs = 15 * 60 * 1000 } = {}) {
  const invoke = (via, source = tree) => runProcess(box, ["run", "--cpu", cpu, "--with-deps",
    ...(via ? ["--via", via] : ["--cache", "--cache-key", cacheKey]), source, "--",
    "sh", "-c", 'echo SMITHERS_CFBOX_COMMAND_STARTED >&2; exec "$@"', "smithers-cfbox", ...command
  ], { cwd: root, signal, streamError: true, timeoutMs })
  const via = process.env.SMITHERS_CFBOX_VIA
  const result = await invoke(via)
  const output = result.stdout + "\n" + result.stderr
  // Exit 125 alone proves nothing: /run can execute before its response is lost,
  // and cfbox calls that an "upload failed" too. Its uncaught fetch error is
  // pre-dispatch: execution POST failures are caught and wrapped as "upload failed".
  const uploadFailed = /^cfbox: R2 (?:upload|multipart (?:create|complete)|part \d+) failed:/m.test(result.stderr) ||
    /^cfbox: TypeError: fetch failed\r?$/m.test(result.stderr)
  if (via || result.status !== 125 || /SMITHERS_CFBOX_COMMAND_STARTED|cfbox: box .* started in/.test(output)) return result
  if (!uploadFailed) {
    console.error("CFBOX status=unclassified_failure exit=125; execution may have been dispatched, no retry")
    return result
  }
  const relay = relayHost()
  if (!relay) {
    console.error("CFBOX status=upload_failed exit=125 relay=unavailable; no retry")
    return result
  }
  signal?.throwIfAborted()
  console.error("CFBOX status=upload_failed exit=125; retrying via relay (cache disabled)")
  // cfbox keys its independent packing cache on the absolute directory path.
  // Rename this disposable tree to force a fresh relay tarball without copying it.
  const relayTree = `${tree}-relay`
  renameSync(tree, relayTree)
  try { return await invoke(relay, relayTree) }
  finally { rmSync(relayTree, { recursive: true, force: true }) }
}
