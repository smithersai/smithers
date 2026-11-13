/** Packed CLI consumer matrix. Run through vm-run on Linux.
 * node packages/smithers/test/node-runtime-matrix.mjs [release-pack-directory|cli.tgz]
 * Without an argument, probes npm next. MATRIX_DISCOVER=1 bypasses ONLY the
 * disposable installed guard to expose link failures; never a candidate receipt.
 * Retains official checksum-verified Node downloads, clean homes and all logs.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { releaseRegistry } from "../../../.smithers/flows/release/release-registry.mjs"
import { installedIdentity, packedIdentity } from "./support/runtime-matrix-identity.mjs"

const root = process.env.MATRIX_OUTPUT ?? mkdtempSync(join(tmpdir(), "smthrs-node-matrix-"))
mkdirSync(root, { recursive: true })
const candidate = process.argv[2] && resolve(process.argv[2])
const discover = process.env.MATRIX_DISCOVER === "1"
const floor = "22.19.0"
const results = []
const graph = new Set()
const run = (command, args, options = {}) => new Promise(resolveResult => {
  const child = spawn(command, args, { timeout: 180_000, ...options, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = "", stderr = ""
  child.stdout.on("data", chunk => { stdout += chunk })
  child.stderr.on("data", chunk => { stderr += chunk })
  child.on("error", error => resolveResult({ status: null, stdout, stderr, error: String(error) }))
  child.on("close", (status, signal) => resolveResult({ status, signal, stdout, stderr }))
})
const must = async (command, args, options) => {
  const r = await run(command, args, options)
  if (r.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${r.error ?? r.stderr}`)
  return r.stdout
}
const record = (version, command, r, expected = 0, receipt = true) => {
  const row = { version, command, status: r.status, signal: r.signal, error: r.error,
    identity: r.identity, identityError: r.identityError,
    expected, receipt, passed: r.status === expected && r.identityError === undefined, output: `${r.stdout}\n${r.stderr}`.slice(-6000) }
  results.push(row)
  console.log(JSON.stringify(row))
}
const loader = join(root, "trace-loader.mjs")
writeFileSync(loader, `import { appendFileSync } from "node:fs"
export async function load(url, context, next) {
  const result = await next(url, context)
  if (url.startsWith("file:")) appendFileSync(process.env.MATRIX_TRACE_FILE, JSON.stringify(url) + "\\n")
  return result
}
`)
const commonjsTrace = join(root, "trace-commonjs.mjs")
writeFileSync(commonjsTrace, `import { appendFileSync } from "node:fs"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
const require = createRequire(import.meta.url)
process.on("exit", () => {
  for (const path of Object.keys(require.cache)) appendFileSync(process.env.MATRIX_TRACE_FILE, JSON.stringify(pathToFileURL(path).href) + "\\n")
})
`)
let registry, proxy
let spec = candidate ?? "@smthrs/cli@next"
let registryUrl
let expectedIdentity = candidate && !statSync(candidate).isDirectory() ? packedIdentity(candidate) : undefined
if (candidate && statSync(candidate).isDirectory()) {
  const entries = JSON.parse(readFileSync(join(candidate, "manifest.json"), "utf8"))
  const cliEntry = entries.find(entry => entry.name === "@smthrs/cli")
  if (!cliEntry) throw new Error("Release pack has no @smthrs/cli candidate")
  expectedIdentity = packedIdentity(join(candidate, cliEntry.filename))
  registry = await releaseRegistry(candidate, entries)
  const names = new Set(entries.map(entry => entry.name))
  // Serve the existing release registry's exact packs; ordinary third-party
  // dependencies still come from npm. This does not publish or move next.
  proxy = createServer(async (request, response) => {
    try {
      const path = request.url
      const name = decodeURIComponent(path.slice(1))
      const upstream = names.has(name) ? registry.url : "https://registry.npmjs.org"
      const fetched = await fetch(upstream + path)
      response.writeHead(fetched.status, { "content-type": fetched.headers.get("content-type") ?? "application/json" })
      response.end(Buffer.from(await fetched.arrayBuffer()))
    } catch { response.writeHead(502).end() }
  })
  await new Promise(resolveListen => proxy.listen(0, "127.0.0.1", resolveListen))
  registryUrl = `http://127.0.0.1:${proxy.address().port}`
  spec = "@smthrs/cli@next"
}
console.log(`MATRIX_OUTPUT=${root}; candidate=${candidate ?? "npm next"}; discovery=${discover}`)
try {
  for (const version of (process.env.MATRIX_VERSIONS ?? "22.4.1,22.15.0,22.19.0,24.19.0,26.4.0").split(",")) {
    const directory = join(root, version)
    mkdirSync(directory, { recursive: true })
    const arch = process.arch === "arm64" ? "arm64" : "x64"
    const archive = `node-v${version}-linux-${arch}.tar.xz`
    await must("curl", ["--fail", "--location", "--retry", "3", "-o", join(directory, archive), `https://nodejs.org/dist/v${version}/${archive}`])
    const sums = await must("curl", ["--fail", "--location", `https://nodejs.org/dist/v${version}/SHASUMS256.txt`])
    const digest = createHash("sha256").update(readFileSync(join(directory, archive))).digest("hex")
    if (!sums.split("\n").some(line => line.trim() === `${digest}  ${archive}`)) throw new Error("Node archive checksum mismatch")
    await must("tar", ["xf", join(directory, archive), "-C", directory])
    const bin = join(directory, `node-v${version}-linux-${arch}`, "bin")
    const cleanEnv = label => {
      const home = join(directory, label)
      mkdirSync(join(home, "tmp"), { recursive: true })
      const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, NO_COLOR: "1",
        TMPDIR: join(home, "tmp"), BUN_INSTALL_CACHE_DIR: join(home, "bun-cache"),
        npm_config_cache: join(home, "npm-cache"), npm_config_yes: "true" }
      delete env.NODE_OPTIONS
      delete env.SMITHERS_BUN
      if (registryUrl) env.npm_config_registry = registryUrl
      return env
    }
    const env = cleanEnv("home")
    const consumer = join(directory, "consumer")
    mkdirSync(consumer)
    if (registryUrl) writeFileSync(join(consumer, ".npmrc"), `registry=${registryUrl}\n`)
    writeFileSync(join(consumer, "package.json"), '{"private":true,"type":"module"}\n')
    const installed = await run(join(bin, "npm"), ["install", "--no-audit", "--no-fund", spec], { cwd: consumer, env })
    writeFileSync(join(directory, "install.log"), `${installed.stdout}\n${installed.stderr}`)
    record(version, "npm install packed CLI", installed)
    if (installed.status !== 0) continue
    const cliDirectory = join(consumer, "node_modules/@smthrs/cli")
    const identity = installedIdentity(cliDirectory)
    expectedIdentity ??= identity
    if (JSON.stringify(identity) !== JSON.stringify(expectedIdentity)) throw new Error("Installed CLI differs from candidate")
    const cli = join(cliDirectory, identity.bin)
    if (discover) {
      const guard = join(consumer, "node_modules/@smthrs/cli/dist/esm/internal/NodeVersion.js")
      writeFileSync(guard, readFileSync(guard, "utf8").replace(/minimum = "[^"]+"/, 'minimum = "0.0.0"'))
    }
    const supported = Number(version.split(".")[0]) > 22 || Number(version.split(".")[1]) >= 19
    for (const [name, args] of [["version", ["--version"]], ["help", ["--help"]], ["init", ["init"]], ["generate", ["generate", "flow", "coding"]]]) {
      const cwd = join(directory, name); mkdirSync(cwd)
      const r = await run(join(bin, "node"), [cli, ...args, ...(discover ? ["--verbose"] : [])], { cwd, env })
      writeFileSync(join(directory, `${name}.log`), `${r.stdout}\n${r.stderr}`)
      record(version, `smthrs ${args.join(" ")}`, r, supported ? 0 : 1)
      if (!discover && !supported && !r.stderr.includes(`smthrs needs Node ${floor} or later`)) results.at(-1).passed = false
      if (!discover && supported && r.status === 0) {
        if (name === "init" && (!existsSync(join(cwd, "WORKSPACE.ts")) || !readFileSync(join(cwd, "WORKSPACE.ts"), "utf8").includes(`>=${floor}`))) results.at(-1).passed = false
        if (name === "generate" && !existsSync(join(cwd, ".smithers/flows/coding/flow.ts"))) results.at(-1).passed = false
      }
    }
    const trace = join(directory, "imports.jsonl")
    const audit = await run(join(bin, "node"), ["--experimental-loader", loader, "--import", commonjsTrace, cli, "--version", "--verbose"], { cwd: consumer, env: { ...env, MATRIX_TRACE_FILE: trace } })
    writeFileSync(join(directory, "audit.log"), `${audit.stdout}\n${audit.stderr}`)
    if (existsSync(trace)) for (const line of readFileSync(trace, "utf8").trim().split("\n")) if (line) graph.add(JSON.parse(line))
    for (const runner of ["npx", "bunx"]) {
      const cwd = join(directory, runner); mkdirSync(cwd)
      if (registryUrl) writeFileSync(join(cwd, ".npmrc"), `registry=${registryUrl}\n`)
      const args = runner === "npx"
        ? ["--yes", "--package", spec, "--", identity.executable, "generate", "flow", "coding"]
        : ["--package", spec, identity.executable, "generate", "flow", "coding"]
      const identityFile = join(directory, runner + "-identity.json")
      rmSync(identityFile, { force: true })
      const runnerEnv = cleanEnv(runner + "-home")
      runnerEnv.MATRIX_IDENTITY_FILE = identityFile
      runnerEnv.NODE_OPTIONS = "--import " + JSON.stringify(new URL("./support/runtime-matrix-identity.mjs", import.meta.url).href)
      const r = await run(runner === "npx" ? join(bin, "npx") : "bunx", args, { cwd, env: runnerEnv })
      if (existsSync(identityFile)) r.identity = JSON.parse(readFileSync(identityFile, "utf8"))
      const identityMatches = JSON.stringify(r.identity) === JSON.stringify(expectedIdentity)
      if (!identityMatches) r.identityError = "Runner did not execute the candidate CLI identity"
      writeFileSync(join(directory, runner + ".log"), r.stdout + "\n" + r.stderr)
      record(version, [runner, ...args].join(" "), r, supported ? 0 : 1)
      if (!discover && !supported && !r.stderr.includes(`smthrs needs Node ${floor} or later`)) results.at(-1).passed = false
      if (!discover && supported && !existsSync(join(cwd, ".smithers/flows/coding/flow.ts"))) results.at(-1).passed = false
    }
    // Each runner starts cold. Its cache is never reused by another row and
    // can be large; retain the installed consumer, outputs and Node binaries.
    if (process.env.MATRIX_KEEP_CACHES !== "1") for (const home of ["home", "npx-home", "bunx-home"]) {
      for (const cache of ["npm-cache", "bun-cache", "tmp"]) rmSync(join(directory, home, cache), { recursive: true, force: true })
    }
  }
} finally {
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolveClose => proxy.close(resolveClose)) }
  if (registry) await registry.close()
  const packages = new Map(), newer = []
  for (const url of graph) {
    const path = new URL(url)
    const lines = readFileSync(path, "utf8").split("\n")
    for (let i = 0; i < lines.length; i++) if (/registerHooks|node:sqlite|node:ffi|RegExp\.escape|Float16Array|Promise\.try|Error\.isError|URLPattern|getBuiltinModule|\.toArray\(|\.toSorted\(|\.toReversed\(|\b(?:await )?using \w/.test(lines[i])) newer.push({ file: path.pathname, line: i + 1, source: lines[i].slice(0, 500) })
    let directory = dirname(path.pathname)
    while (directory !== dirname(directory)) {
      const manifest = join(directory, "package.json")
      if (existsSync(manifest)) {
        const p = JSON.parse(readFileSync(manifest, "utf8"))
        if (p.name) { packages.set(`${p.name}@${p.version}`, { name: p.name, version: p.version, engines: p.engines, manifest }); break }
      }
      directory = dirname(directory)
    }
  }
  writeFileSync(join(root, "import-audit.json"), JSON.stringify({ files: [...graph], packages: [...packages.values()], newer }, null, 2) + "\n")
  writeFileSync(join(root, "results.json"), JSON.stringify({ spec, candidate, discover, results }, null, 2) + "\n")
  console.log(`AUDIT ${graph.size} modules, ${packages.size} packages; ${root}/import-audit.json`)
}
if (!discover && results.some(r => !r.passed)) process.exitCode = 1
