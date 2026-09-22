/** Private slow-test launcher. It selects existing fixtures, not a new test engine. */
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { constants, createReadStream } from "node:fs"
import { access, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const nativeTests = [
  "coding-native.test.ts", "coding-workspace-helper.test.ts", "coding-filesystem-native.test.ts", "coding-checks.test.ts", "coding-wiki-check.test.ts",
  "coding-atoms.test.ts", "coding-correction.test.ts", "coding-planning.test.ts", "coding-planning-wiki.test.ts",
  "coding-poc.test.ts", "coding-feedback.test.ts", "coding-host-native.test.ts", "coding-request-host.test.ts",
  "coding-dispatch-host.test.ts", "coding-vibe-cleanup.test.ts",
  // The repository fixtures that read the Plue adapter or exporter path and
  // skip every case without it. They were in no target and in no gate, so the
  // only way any of them ran was by hand. Run unattended they report a green
  // exit having asserted nothing; run here the preflight refuses instead, so a
  // missing prerequisite is a failure rather than an invisible skip.
  // `repository-check-context` and `repository-checks` are also declared in
  // `//flows:repository`, which covers the cases that need no native tool.
  "repository-check-context.test.ts", "repository-checks.test.ts", "repository-durable-pins.test.ts",
  "repository-eval-source.test.ts", "repository-host.test.ts", "repository-main-retention.test.ts",
  "repository-preserved-source.test.ts", "repository-source-import.test.ts", "repository-trigger.test.ts"
]
// These three standalone fixtures hardwire the Node runtime: the atom and
// correction fixtures build NodeRuntime directly, and the dispatch host imports
// NodeControlHost without the `process.versions.bun` branch its request-host
// sibling carries. The Bun request-host fixture exercises the production
// atom/correction composition through Bun DI.
//
// Of the nine repository fixtures, `repository-source-import` and
// `repository-main-retention` each exit 1 under Bun 1.4.0 on a teardown their
// Node run completes: `server.close()` after `closeAllConnections()` raises
// ERR_SERVER_NOT_RUNNING between tests. `repository-durable-pins` is measured
// green under Bun and is not listed here. The remaining six are listed because
// their Bun behaviour is unmeasured, not because it is known bad; move one out
// once its Bun run is green, never on the assumption that it is.
const nodeOnly = ["coding-atoms.test.ts", "coding-correction.test.ts", "coding-dispatch-host.test.ts",
  "repository-check-context.test.ts", "repository-checks.test.ts", "repository-eval-source.test.ts",
  "repository-host.test.ts", "repository-main-retention.test.ts", "repository-preserved-source.test.ts",
  "repository-source-import.test.ts", "repository-trigger.test.ts"]
export const bunNativeTests = nativeTests.filter(name => !nodeOnly.includes(name))

const digest = async path => {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}
const run = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { stdio: "inherit", env,
    cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 25 * 60_000, killSignal: "SIGTERM" })
  child.once("error", reject)
  child.once("exit", (code, signal) => signal ? reject(new Error(`Coding acceptance ended on ${signal}`))
    : code === 0 ? resolve() : reject(new Error(`Coding acceptance exited ${code ?? 1}`)))
})

export const main = async (mode = "source", selected) => {
  if (mode !== "source" && mode !== "bundle") throw new Error("Coding native gate mode must be source or bundle")
  const available = process.versions.bun ? bunNativeTests : nativeTests
  if (selected !== undefined && (mode !== "source" || !available.includes(selected))) {
    throw new Error("Select an existing source fixture for this runtime, or omit the selection for the full gate")
  }
  const helper = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY ?? "/usr/local/bin/smithers-jj-export"
  if (!helper) throw new Error("Native coding gates require the packaged workspace helper")
  try {
    await access(helper, constants.R_OK | constants.X_OK)
    if (!(await stat(helper)).isFile()) throw new Error("Expected a regular helper")
  }
  catch { throw new Error("Native coding prerequisite is missing: set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY to the built helper") }
  const jj = execFileSync("jj", ["--version"], { encoding: "utf8", timeout: 30_000, maxBuffer: 65_536 }).trim()
  // These are measured preflight facts, not claims that host tools are build outputs.
  console.log(JSON.stringify({ runtime: process.versions.bun ? "bun" : "node",
    runtimeVersion: process.versions.bun ?? process.versions.node, jj,
    helperSha256: await digest(helper) }))
  const env = { ...process.env, SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: resolve(helper) }
  if (mode === "bundle") {
    for (const mode of ["plan", "request"]) await run(["flows/test/coding-host-bundle.mjs", mode], env)
  } else {
    for (const test of selected === undefined ? available : [selected]) {
      console.log(`Native coding gate: ${test}`)
      await run(process.versions.bun ? ["test", `flows/test/${test}`]
        : ["--experimental-strip-types", "--test", "--test-concurrency=1", `flows/test/${test}`], env)
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(process.argv[2], process.argv[3]) }
  catch (error) { console.error(error instanceof Error ? error.message : "Native coding gate failed"); process.exitCode = 1 }
}
