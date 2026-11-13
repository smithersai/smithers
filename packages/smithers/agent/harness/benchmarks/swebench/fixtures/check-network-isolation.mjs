/** Real Docker probes: concurrent ownership, portable deadlines and launch failures. */
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout } from "node:timers/promises"

const rig = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "swebench-network-isolation-"))
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" })
const children = []
const owned = []
const owner = temporary.split("/").at(-1).toLowerCase()
const preflight = readFileSync(join(rig, "preflight-network.sh"), "utf8")
const dryrun = readFileSync(join(rig, "network-dryrun.sh"), "utf8")

try {
  // Refuse to exercise the historical broad deletion against a shared daemon.
  for (const script of [preflight, dryrun]) {
    assert.doesNotMatch(script, /name=\^swb-(?:preflight|netdry)-"/, "cleanup must scope discovery to its invocation")
  }
  assert.equal(docker("info").status, 0, "a real Docker daemon is required")
  assert.equal(docker("image", "inspect", "alpine:3").status, 0, "provision alpine:3 before running this check")

  const bin = join(temporary, "bin")
  mkdirSync(bin)
  // Every executable is real; GNU timeout is deliberately absent.
  for (const name of ["bash", "dirname", "mkdir", "sed", "tr", "grep", "rm", "node", "python3", "docker"]) {
    const found = spawnSync("bash", ["-c", "command -v \"$1\"", "find-tool", name], { encoding: "utf8" })
    assert.equal(found.status, 0, name)
    symlinkSync(found.stdout.trim(), join(bin, name))
  }
  assert.equal(spawnSync("bash", ["-c", "command -v timeout"], { env: { ...process.env, PATH: bin } }).status, 1)
  const image = join(temporary, "image.sh")
  const command = join(temporary, "command.sh")
  writeFileSync(image, "#!/bin/sh\necho alpine:3\n", { mode: 0o755 })
  writeFileSync(command, "#!/bin/sh\nprintf \"%s\\n\" \"$PROBE_COMMAND\"\n", { mode: 0o755 })
  const environment = (name, suite) => ({
    ...process.env,
    PATH: bin,
    PROBE_COMMAND: suite,
    SWB_PREFLIGHT_IMAGE_CMD: image,
    SWB_PREFLIGHT_TEST_CMD: command,
    SWB_NETWORK_OWNER: owner,
    SWB_PREFLIGHT_LOGS: join(temporary, "logs"),
    SWB_PREFLIGHT_MANIFEST: join(temporary, "missing-manifest.jsonl"),
    SWB_PREFLIGHT_TIMEOUT: "30",
    SWB_PREFLIGHT_SHELL: "sh",
    SWB_PREFLIGHT_INSTANCES: "probe__probe-1"
  })
  const start = (name, suite) => {
    const child = spawn("bash", [join(rig, "preflight-network.sh"), "--report", join(temporary, `${name}.json`)], {
      env: environment(name, suite),
      stdio: ["ignore", "pipe", "pipe"]
    })
    let output = ""
    child.stdout.on("data", (chunk) => {
      output += chunk
    })
    child.stderr.on("data", (chunk) => {
      output += chunk
    })
    const done = new Promise((accept, reject) => {
      child.on("error", reject)
      child.on("close", (status) => accept({ status, output }))
    })
    children.push(child)
    return { child, done }
  }
  const result = async (name, run, status) => {
    const completed = await run.done
    assert.equal(completed.status, status, completed.output)
    return JSON.parse(readFileSync(join(temporary, `${name}.json`), "utf8"))
  }

  // Concurrent invocations probe the same instance. The faster exit must leave
  // the slow invocation's active container intact.
  const slow = start(
    "slow",
    "if ip route | grep -q default; then exit 0; fi; echo slow-suite; until [ -f /tmp/probe-finished ]; do sleep 0.1; done"
  )
  let active = []
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const listing = docker("ps", "--format", "{{.Names}}", "--filter", `name=^swb-preflight-${owner}-`)
    active = listing.stdout.trim().split("\n").filter((name) => name.includes("probe--probe-1-none"))
    if (active.length > 0) break
    await setTimeout(50)
  }
  assert.ok(active.length > 0, "the first invocation has an active probe")
  const fast = start("fast", "echo fast-suite; exit 0")
  const fastReport = await result("fast", fast, 0)
  assert.equal(fastReport.probes, 1, "the probe works with no timeout executable on PATH")
  assert.deepEqual([fastReport.rows[0].noneExit, fastReport.rows[0].bridgeExit], [0, 0])
  for (const name of active) {
    assert.equal(docker("inspect", name).status, 0, "another invocation's cleanup left it alive")
    assert.equal(docker("exec", name, "touch", "/tmp/probe-finished").status, 0)
  }
  const slowReport = await result("slow", slow, 0)
  assert.equal(slowReport.probes, 1)
  const logRoots = new Set()
  for (const name of ["slow-suite", "fast-suite"]) {
    const found = spawnSync("find", [join(temporary, "logs"), "-name", "*.none.log"], { encoding: "utf8" })
    const matches = found.stdout.trim().split("\n").filter((path) => readFileSync(path, "utf8").includes(name))
    assert.equal(matches.length, 1, "each invocation retains its own suite evidence")
    logRoots.add(matches[0])
  }
  assert.equal(logRoots.size, 2, "a shared log root still isolates concurrent invocations")

  for (const tool of ["python3", "docker", "node"]) {
    const path = join(bin, tool)
    const target = spawnSync("readlink", [path], { encoding: "utf8" }).stdout.trim()
    rmSync(path)
    const missing = spawnSync("bash", [join(rig, "preflight-network.sh")], {
      env: environment("missing-tool", "exit 0"),
      encoding: "utf8"
    })
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, new RegExp(`required tool not found: ${tool}`))
    symlinkSync(target, path)
  }

  for (
    const [name, suite, exit] of [
      ["missing-command", "exec /missing-suite-command", 127],
      ["unexecutable", "exec /", 126]
    ]
  ) {
    const report = await result(name, start(name, suite), 2)
    assert.equal(report.probes, 0)
    assert.equal(report.inconclusive, 1)
    assert.equal(report.rows[0].verdict, "inconclusive")
    assert.deepEqual([report.rows[0].noneExit, report.rows[0].bridgeExit], [exit, exit])
  }

  // Run the actual dry-run cleanup against real containers. An unrelated
  // preflight and an unrelated dry run must both survive.
  for (const prefix of ["swb-preflight-", "swb-netdry-"]) {
    const name = `${prefix}${owner}-sentinel`
    assert.equal(docker("run", "-d", "--name", name, "alpine:3", "sleep", "60").status, 0)
    owned.push(name)
  }
  const begin = dryrun.indexOf("TMP=\"$(mktemp")
  const end = dryrun.indexOf("trap cleanup EXIT", begin) + "trap cleanup EXIT".length
  assert.ok(begin >= 0 && end > begin)
  const cleanup = spawnSync("bash", ["-c", dryrun.slice(begin, end)], { encoding: "utf8", env: process.env })
  assert.equal(cleanup.status, 0, cleanup.stderr)
  for (const name of owned) {
    assert.equal(docker("inspect", name).status, 0, "dry-run cleanup preserves foreign containers")
  }
  console.log("check-network-isolation: concurrent probes, owned cleanup, portable deadlines and launch failures pass")
} finally {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM")
  for (const name of owned) docker("rm", "-f", name)
  rmSync(temporary, { recursive: true, force: true })
}
