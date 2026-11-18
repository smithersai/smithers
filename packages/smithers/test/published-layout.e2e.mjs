/**
 * `smthrs` as a stranger gets it: the packed tarballs installed with npm in an
 * empty directory, with no workspace around them. An installation runs the
 * whole program as one file (`dist/bundle/bin.js`), which no test of the
 * sources runs, so this file is what holds that it behaves as the separate
 * modules do and how fast it starts.
 *
 * The first-party packages come from the release tarballs through a loopback
 * registry, so this proves a version before it is on npm. Everything else comes
 * from the public registry, as it does for a stranger.
 *
 * usage: pnpm exec smthrs build '//packages/...:lib'
 *        node packages/smithers/test/published-layout.e2e.mjs [pack-directory]
 *
 * With no directory it packs the release set from the built packages. A flow
 * needs the `smithers-jj-export` helper: a final release pack carries it, and
 * an earlier one is given it as `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY`, as the
 * release smoke is.
 *
 * ## Benchmark: how long `smthrs` takes to start
 *
 * **Shape.** Two commands an agent's feedback loop is made of. `smthrs
 * --version`: the least a start can do. `smthrs ci //...` in a workspace of
 * four shell checks whose results are all in the cache: everything a run does
 * except the checks themselves, which is the part Smithers adds to any CI.
 *
 * **Method.** Each command runs once to warm up (Node writes its compile cache
 * and the four results are stored), then five times; the best wall time of the
 * five is kept, because the machine is shared and one slow start says nothing
 * about the code. Beside each run the test records the CPU time of the command
 * and its children (the shell's `times`) and the one-minute load average.
 *
 * **What it holds.** At a load average under one per core, the best
 * `--version` takes at most 1.0 s and the best all-hit `ci` at most 2.0 s of
 * wall time. Measured on the build server (32 usable cores, Node 26.5, load 29 to 33,
 * 2026-11-18): 0.36 to 0.40 s and 1.10 to 1.17 s. Before the bundle the same
 * two commands took 6.5 s and 12.8 s at load 18 to 26.
 *
 * **Limits.** On a busier host wall time measures the host: the same commands
 * took 0.85 s and 2.3 s at load 110 to 160. There the test holds the CPU time
 * instead, which does not move with load as wall time does: at most 1.0 s for
 * `--version` and 2.5 s for the all-hit `ci` (measured 0.4 to 0.65 s and 1.4
 * to 2.2 s across loads 29 to 250). It does not measure a first start, which
 * also writes the compile cache (about 0.4 s more), or a run that executes a
 * check.
 */
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { availableParallelism, loadavg, tmpdir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { after, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { releaseRegistry } from "../../../.smithers/flows/release/release-registry.mjs"

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url))

const packRelease = () => {
  const directory = mkdtempSync(join(tmpdir(), "smthrs-published-packs-"))
  execFileSync(process.execPath, [".smithers/flows/release/pack-release.mjs", directory, "--built"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "ignore", "inherit"]
  })
  return directory
}

const given = process.argv[2]
const packs = given === undefined ? packRelease() : resolve(given)
const entries = JSON.parse(readFileSync(join(packs, "manifest.json"), "utf8"))
const version = entries.find((entry) => entry.name === "@smthrs/cli").version

/** Installing the whole release takes minutes on a loaded machine. */
const commandLimitMs = 15 * 60 * 1000

const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-published-")))
const home = join(root, "home")
const consumer = join(root, "consumer")
const bin = dirname(process.execPath)
const tools = join(root, "tools")
const environment = {
  HOME: home,
  // This Node, npm, and the sandbox a check runs in where this machine keeps it off the system path.
  PATH: [tools, "/usr/bin", "/bin"].join(delimiter),
  NODE_COMPILE_CACHE: join(root, "compile-cache"),
  // The native helper a flow's workspace capture uses, where this machine names one.
  ...(process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY === undefined
    ? {}
    : { SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY })
}
const installed = join(consumer, "node_modules/@smthrs/cli")
const shim = join(installed, "bin/smithers.mjs")

const run = (command, args, options) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env: environment, ...options, stdio: ["ignore", "pipe", "pipe"], timeout: commandLimitMs, killSignal: "SIGKILL" })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.once("error", reject)
    child.once("close", (status, signal) => resolveRun({ status, signal, stdout, stderr }))
  })

/** Starts the installed `smthrs`. */
const smthrs = (cwd, args, extra = {}) =>
  spawnSync(process.execPath, [shim, ...args], { cwd, env: { ...environment, ...extra }, encoding: "utf8", timeout: commandLimitMs })

/** Starts the same program from its separate modules: the entry `@smthrs/cli/bin` names. */
const separateModules = (cwd, args) =>
  spawnSync(process.execPath, [join(installed, "dist/esm/bin.js"), ...args], { cwd, env: environment, encoding: "utf8", timeout: commandLimitMs })

const passed = (result, what) => {
  assert.equal(result.status, 0, `${what}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-c", "user.name=Stranger", "-c", "user.email=stranger@example.test", ...args], { cwd, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
}

/** A workspace of four shell checks over two files. */
const workspaceIn = (name) => {
  const directory = join(root, name)
  mkdirSync(join(directory, ".smithers"), { recursive: true })
  writeFileSync(join(directory, "a.txt"), "a\n")
  writeFileSync(join(directory, "b.txt"), "b\n")
  writeFileSync(join(directory, ".gitignore"), ".flows\n")
  writeFileSync(join(directory, ".smithers/WORKSPACE.ts"), [
    "import { Smithers as S } from \"@smthrs/targets\"",
    "",
    "export const Workspace = S.Workspace(\"four\", {",
    "  repository: \"four\",",
    "  cache: S.Cache({ directory: \".flows\" }),",
    "  host: S.Host({ bins: [\"bash\", \"sh\", \"test\", \"grep\"] })",
    "})",
    ""
  ].join("\n"))
  writeFileSync(join(directory, "PACKAGE.ts"), [
    "import { Smithers as S } from \"@smthrs/targets\"",
    "",
    "const one = S.Shell.Test({ shell: \"test -f a.txt\", data: [S.file(\"a.txt\")] })",
    "const two = S.Shell.Test({ shell: \"test -f b.txt\", data: [S.file(\"b.txt\")] })",
    "const three = S.Shell.Test({ shell: \"grep -q a a.txt\", data: [S.file(\"a.txt\")] })",
    "const four = S.Shell.Test({ shell: \"grep -q b b.txt\", data: [S.file(\"b.txt\")] })",
    "",
    "export const Package = S.Package({ targets: { one, two, three, four } })",
    ""
  ].join("\n"))
  git(root, "init", "-q", "-b", "main", directory)
  git(directory, "add", "--all")
  git(directory, "commit", "-q", "-m", "four checks")
  return directory
}

const statuses = (stdout) => {
  const report = JSON.parse(stdout)
  return Object.fromEntries(report.results.map((result) => [result.label, result.status]))
}

let registry
before(async () => {
  mkdirSync(home)
  mkdirSync(consumer)
  mkdirSync(tools)
  for (const name of ["node", "npm", "npx"]) symlinkSync(join(bin, name), join(tools, name))
  const bubblewrap = spawnSync("which", ["bwrap"], { encoding: "utf8" }).stdout.trim()
  if (bubblewrap !== "") symlinkSync(realpathSync(bubblewrap), join(tools, "bwrap"))
  registry = await releaseRegistry(packs, entries)
  writeFileSync(join(home, ".npmrc"), `@smthrs:registry=${registry.url}/\n`)
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }) + "\n")
  // `smithers-ci` depends on `@smthrs/cli`, so one install is what a stranger of either has.
  // It is not in the `@smthrs` scope the registry serves, so it is installed from its tarball.
  const ci = join(packs, entries.find((entry) => entry.name === "smithers-ci").filename)
  const result = await run(join(tools, "npm"), ["install", "--no-audit", "--no-fund", ci, `@smthrs/cli@${version}`], { cwd: consumer })
  assert.equal(result.status, 0, `npm install\n${result.stdout}\n${result.stderr}`)
}, { timeout: commandLimitMs })
after(async () => {
  await registry?.close()
  rmSync(root, { recursive: true, force: true })
  if (given === undefined) rmSync(packs, { recursive: true, force: true })
})

describe("the installed program", () => {
  it("is the one file, with the separate modules beside it", () => {
    assert.ok(existsSync(join(installed, "dist/bundle/bin.js")))
    assert.ok(existsSync(join(installed, "dist/esm/bin.js")))
    assert.ok(existsSync(join(installed, "bin/bundle-origin.mjs")))
    assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version, version)
  })

  it("starts from the one file and loads none of the separate modules of the command tree", () => {
    const receipt = join(root, "loaded.json")
    const observe = "data:text/javascript," + encodeURIComponent([
      "import { registerHooks } from \"node:module\"",
      "import { writeFileSync } from \"node:fs\"",
      "const loaded = new Set()",
      "registerHooks({ load(url, context, next) { loaded.add(url); return next(url, context) } })",
      `process.on("exit", () => writeFileSync(${JSON.stringify(receipt)}, JSON.stringify([...loaded])))`
    ].join("\n"))
    const result = spawnSync(process.execPath, ["--import", observe, shim, "--help"], { cwd: consumer, env: environment, encoding: "utf8" })
    passed(result, "smthrs --help")
    const loaded = JSON.parse(readFileSync(receipt, "utf8"))
    assert.ok(loaded.some((url) => url.endsWith("/@smthrs/cli/dist/bundle/bin.js")))
    assert.deepEqual(loaded.filter((url) => /\/@smthrs\/[^/]+\/dist\/esm\/(?!internal\/NodeVersion\.js$)/.test(url)), [])
    // A start loads the launcher, the bundle and the few packages left outside it.
    assert.ok(loaded.filter((url) => url.startsWith("file:")).length < 100, `${loaded.length} modules loaded`)
  })

  it("prints its version, the same from either form", () => {
    const one = smthrs(consumer, ["--version"])
    assert.equal(passed(one, "smthrs --version"), `${version}\n`)
    assert.equal(one.stderr, "")
    const separate = separateModules(consumer, ["--version"])
    assert.equal(passed(separate, "smthrs --version, separate modules"), `${version}\n`)
  })

  // The same command, flags, output and exit code from the one file as from the modules it was made of.
  for (const args of [["--help"], ["ci", "--help"], ["flow", "--help"], ["--version", "--json"], ["no-such-command"], ["ci", "--no-such-flag"]]) {
    it(`answers ${JSON.stringify(args.join(" "))} as the separate modules do`, () => {
      const one = smthrs(consumer, args)
      const separate = separateModules(consumer, args)
      assert.equal(one.status, separate.status, `${one.stdout}\n${one.stderr}`)
      assert.equal(one.stdout, separate.stdout)
      assert.equal(one.stderr, separate.stderr)
      assert.notEqual(`${one.stdout}${one.stderr}`, "")
    })
  }
})

describe("a workspace with PACKAGE.ts targets", () => {
  let workspace
  before(() => {
    workspace = workspaceIn("workspace")
  })

  it("runs every check, then reuses every result", () => {
    const first = statuses(passed(smthrs(workspace, ["ci", "//...", "--json"]), "smthrs ci, empty cache"))
    assert.deepEqual(first, { "//:one": "ran", "//:two": "ran", "//:three": "ran", "//:four": "ran" })
    const second = statuses(passed(smthrs(workspace, ["ci", "//...", "--json"]), "smthrs ci, full cache"))
    assert.deepEqual(second, { "//:one": "hit", "//:two": "hit", "//:three": "hit", "//:four": "hit" })
  })

  it("runs again only the checks that read a changed file", () => {
    writeFileSync(join(workspace, "a.txt"), "a again\n")
    const result = statuses(passed(smthrs(workspace, ["ci", "//...", "--json"]), "smthrs ci, one file changed"))
    assert.deepEqual(result, { "//:one": "ran", "//:two": "hit", "//:three": "ran", "//:four": "hit" })
  })

  it("fails the run when a check fails, and names it", () => {
    writeFileSync(join(workspace, "b.txt"), "nothing\n")
    const result = smthrs(workspace, ["ci", "//...", "--json"])
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}${result.stderr}`, /\/\/:four/)
  })

  it("reuses what the separate modules did not store, and stores it under another key", () => {
    // The two forms are different bytes, and a result is keyed by the bytes
    // that produced it, so neither answers from the other's results.
    const fresh = workspaceIn("workspace-keys")
    const one = JSON.parse(passed(smthrs(fresh, ["ci", "//...", "--json"]), "smthrs ci, one file"))
    const separate = JSON.parse(passed(separateModules(fresh, ["ci", "//...", "--json"]), "smthrs ci, separate modules"))
    assert.deepEqual(separate.results.map((result) => result.status), ["ran", "ran", "ran", "ran"])
    assert.notDeepEqual(one.results.map((result) => result.key), separate.results.map((result) => result.key))
  })
})

describe("a flow", () => {
  it("runs to its result with the Effect and flow packages the program holds", () => {
    const project = join(root, "flow-project")
    const executed = join(project, "executed.txt")
    mkdirSync(join(project, ".smithers/flows/echo"), { recursive: true })
    writeFileSync(join(project, ".smithers/flows/echo/flow.ts"), [
      "import { Action, Flow } from \"@smthrs/flow\"",
      "import { Node } from \"@smthrs/plan\"",
      "import { Effect, Schema } from \"effect\"",
      "import { writeFileSync } from \"node:fs\"",
      "const Echo = Action.make(\"echo/Value\", { implementationVersion: \"echo/v1\", payload: { value: Schema.String }, success: Schema.String })",
      "export const layer = Echo.toLayer(({ value }) => Effect.sync(() => {",
      `  writeFileSync(${JSON.stringify(executed)}, value)`,
      "  return value",
      "}), { implementationVersion: \"echo/v1\" })",
      "export default Flow.make(\"echo\", {",
      "  description: \"Echo a string offline\", capabilities: [\"fs:write:**\"],",
      "  effects: { reads: [], writes: [\"executed.txt\"], mode: \"expected\", onConflict: \"serialize\", tier: \"irreversible\" },",
      "  payload: { value: Schema.String }, success: Schema.String,",
      "  body: Node.capture({ action: Echo.name, implementationVersion: \"echo/v1\" }, ({ value }) => Echo.call({ value }))",
      "})",
      ""
    ].join("\n"))
    git(root, "init", "-q", "-b", "main", project)
    const listed = passed(smthrs(project, ["flow", "list", "--root", project, "--json"], { SMITHERS_BACKEND: "sqlite" }), "smthrs flow list")
    assert.match(listed, /"echo"/)
    const started = smthrs(project, ["flow", "start", "echo", "--data", JSON.stringify({ value: "from the one file" }), "--wait", "--root", project, "--json"], { SMITHERS_BACKEND: "sqlite" })
    passed(started, "smthrs flow start echo --wait")
    assert.equal(readFileSync(executed, "utf8"), "from the one file")
  })
})

describe("smithers-ci on a small repository", () => {
  it("replays two commits through the installed smthrs", async () => {
    const repository = join(root, "repository")
    mkdirSync(join(repository, ".github/workflows"), { recursive: true })
    writeFileSync(join(repository, ".github/workflows/ci.yml"), [
      "name: CI",
      "on: [push]",
      "jobs:",
      "  check:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - run: test -f app.txt",
      ""
    ].join("\n"))
    git(root, "init", "-q", "-b", "main", repository)
    for (const text of ["one", "two", "three"]) {
      writeFileSync(join(repository, "app.txt"), `${text}\n`)
      git(repository, "add", "--all")
      git(repository, "commit", "-q", "-m", text)
    }
    const result = await run(process.execPath, [join(consumer, "node_modules/smithers-ci/bin/smithers-ci.mjs"), "replay", "--commits", "2", "--json"], { cwd: repository })
    const report = JSON.parse(passed(result, "smithers-ci replay --commits 2 --json"))
    assert.equal(report.commits.length, 2)
    assert.equal(report.mismatches, 0)
    for (const commit of report.commits) {
      assert.equal(commit.baseline.ok, true)
      assert.equal(commit.normal.ok, true)
    }
  })
})

describe("how long smthrs takes to start", () => {
  /** Runs a command five times; the best wall time, with each run's CPU time and the load beside it. */
  const measure = (cwd, args) => {
    const runs = []
    for (let index = 0; index < 5; index++) {
      const load = loadavg()[0]
      const started = performance.now()
      // `times` prints the shell's own user and system time, then its children's.
      const result = spawnSync("bash", ["-c", "\"$0\" \"$@\" >/dev/null 2>&1; status=$?; times; exit $status", process.execPath, shim, ...args], { cwd, env: environment, encoding: "utf8" })
      const wall = (performance.now() - started) / 1000
      assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`)
      const seconds = (text) => {
        const [, minutes, rest] = /^(\d+)m([\d.]+)s$/.exec(text)
        return Number(minutes) * 60 + Number(rest)
      }
      const [user, system] = result.stdout.trim().split("\n")[1].split(/\s+/).map(seconds)
      runs.push({ wall, cpu: user + system, load })
    }
    return runs
  }

  const hold = (name, runs, wallLimit, cpuLimit) => {
    const wall = Math.min(...runs.map((entry) => entry.wall))
    const cpu = Math.min(...runs.map((entry) => entry.cpu))
    const load = Math.max(...runs.map((entry) => entry.load))
    const quiet = load < availableParallelism()
    console.log(
      `${name}: best of ${runs.length} ${wall.toFixed(2)} s wall, ${cpu.toFixed(2)} s CPU, load ${load.toFixed(1)} on ${availableParallelism()} cores; ` +
        runs.map((entry) => `${entry.wall.toFixed(2)}/${entry.cpu.toFixed(2)}@${entry.load.toFixed(0)}`).join(" ") +
        (quiet ? `; limit ${wallLimit.toFixed(1)} s wall` : `; host too busy for wall time, limit ${cpuLimit.toFixed(1)} s CPU`)
    )
    if (quiet) assert.ok(wall <= wallLimit, `${name} took ${wall.toFixed(2)} s; the limit is ${wallLimit.toFixed(1)} s`)
    else assert.ok(cpu <= cpuLimit, `${name} used ${cpu.toFixed(2)} s of CPU; the limit on a busy host is ${cpuLimit.toFixed(1)} s`)
  }

  it("answers --version within 1.0 s", () => {
    passed(smthrs(consumer, ["--version"]), "warm-up")
    hold("smthrs --version", measure(consumer, ["--version"]), 1.0, 1.0)
  })

  it("runs a workspace of four checks whose results are all stored within 2.0 s", () => {
    const workspace = workspaceIn("workspace-timed")
    passed(smthrs(workspace, ["ci", "//..."]), "warm-up")
    const warm = statuses(passed(smthrs(workspace, ["ci", "//...", "--json"]), "all stored"))
    assert.deepEqual(Object.values(warm), ["hit", "hit", "hit", "hit"])
    hold("smthrs ci //... (four checks, all stored)", measure(workspace, ["ci", "//..."]), 2.0, 2.5)
  })
})
