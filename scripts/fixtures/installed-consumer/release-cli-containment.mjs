// Runs entirely from the external consumer: no workspace imports or source loader.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { assertInstalledConsumer } from "./consumer-boundary.mjs"

assertInstalledConsumer(import.meta.url)
const format = process.argv[2]
assert.ok(format === "esm" || format === "cjs")
const require = createRequire(import.meta.url)
const ProcessReaper = format === "cjs"
  ? require("@smthrs/platform-node/ProcessReaper")
  : await import("@smthrs/platform-node/ProcessReaper")
const executable = format === "esm"
  ? fileURLToPath(import.meta.resolve("@smthrs/cli/bin"))
  : require.resolve("@smthrs/cli/bin")
assert.ok(executable.replaceAll("\\", "/").endsWith(`/dist/${format}/bin.js`), executable)
const preload = new URL("./release-recorded-provider.mjs", import.meta.url).href
const isAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== "ESRCH" }
}
const parentPid = (pid) => {
  try { return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim()) }
  catch { return undefined }
}
const processState = (pid) => {
  const result = spawnSync("/bin/ps", ["-o", "pgid=,stat=", "-p", String(pid)], {
    encoding: "utf8", timeout: 1000
  })
  if (result.status !== 0) return undefined
  const [group, state] = result.stdout.trim().split(/\s+/)
  return { group: Number(group), stopped: state?.startsWith("T") === true }
}
const waitFor = async (predicate, label, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Installed ${format}: timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const containment = async (kind, recovery) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `smthrs-installed-${format}-${kind}-${recovery}-`)))
  const recording = join(root, "recording")
  mkdirSync(recording)
  const marker = join(recording, "child.pid")
  const mcpConfig = join(recording, "mcp.json")
  const environment = {
    NODE_OPTIONS: `--import=${preload}`,
    SMITHERS_TEST_RECORDING: recording,
    SMITHERS_OPENAI_AUTH: "api-key",
    OPENAI_API_KEY: "recorded-fixture-not-a-real-key"
  }
  for (const key of ["PATH", "TMPDIR", "SystemRoot", "WINDIR"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  const records = (file) => existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []
  const mcpProcesses = () => records(join(recording, "mcp-pids.jsonl"))
  const invoke = (...args) => {
    const result = spawnSync(process.execPath, [executable, ...args,
      ...(kind === "mcp" ? ["--mcp-config", mcpConfig] : []), "--json"], {
      cwd: root, env: environment, encoding: "utf8", timeout: 45_000, maxBuffer: 1024 * 1024
    })
    // Capture leaked fixture processes before a failed command or JSON parse
    // can throw, including the final replacement command's MCP pair.
    captureRecorded()
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${format} ${kind}: ${result.stderr}\n${result.stdout}`)
    return { pid: result.pid, value: JSON.parse(result.stdout) }
  }
  const ledger = () => {
    const database = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
    try {
      return database.prepare(
        "SELECT event_type, payload_json FROM flows_journal_events WHERE event_type LIKE 'flows.host.process-%' ORDER BY emitted_at_ms, seq"
      ).all().map((row) => ({ kind: row.event_type, payload: JSON.parse(row.payload_json) }))
    } finally { database.close() }
  }
  // Teardown signals only identities observed alive in this fixture, never a
  // recycled PID or a broad process-name/process-group match.
  const owned = new Map()
  const remember = (pid) => {
    assert.ok(Number.isSafeInteger(pid) && pid > 1, `Invalid fixture PID: ${pid}`)
    const started = ProcessReaper.posixSystem.startedAtMs(pid)
    assert.equal(started._tag, "started", `Cannot identify fixture PID ${pid}`)
    if (owned.has(pid)) assert.equal(started.startedAtMs, owned.get(pid), `Fixture PID ${pid} was reused`)
    else owned.set(pid, started.startedAtMs)
    return pid
  }
  const captureRecorded = () => {
    const pids = [
      ...records(join(recording, "processes.jsonl")).filter((entry) => entry.event === "start").map((entry) => entry.pid),
      ...mcpProcesses().flatMap((entry) => [entry.pid, entry.supervisor])
    ]
    for (const pid of pids) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || owned.has(pid)) continue
      const started = ProcessReaper.posixSystem.startedAtMs(pid)
      if (started._tag === "started") owned.set(pid, started.startedAtMs)
    }
  }
  const assertCompletedMcps = (supervisor) => {
    for (const entry of mcpProcesses().filter((entry) => entry.supervisor !== supervisor)) {
      assert.equal(isAlive(entry.pid), false, `Completed command left MCP target ${entry.pid} alive`)
      assert.equal(isAlive(entry.supervisor), false, `Completed command left MCP supervisor ${entry.supervisor} alive`)
    }
  }
  const signalOwned = (pid, signal) => {
    const current = ProcessReaper.posixSystem.startedAtMs(pid)
    assert.equal(current._tag, "started", `Fixture PID ${pid} exited before ${signal}`)
    assert.equal(current.startedAtMs, owned.get(pid), `Fixture PID ${pid} was reused before ${signal}`)
    process.kill(pid, signal)
  }
  let testError
  try {
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0)
    writeFileSync(join(root, ".gitignore"), ".flows/\nrecording/\n")
    for (const name of ["busy", "done"]) {
      mkdirSync(join(root, "flows", name), { recursive: true })
      writeFileSync(join(root, "flows", name, "flow.mdx"), [
        "---", `name: ${name}`, "description: Installed containment exercise.",
        "model: openai:gpt-4o-mini",
        name === "busy" && kind === "shell" ? 'capabilities: ["proc:spawn:*"]' : "capabilities: []",
        "---", "Perform the recorded exercise."
      ].join("\n"))
    }
    const script = [
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid))`,
      'process.on("SIGTERM", () => {})', "setInterval(() => {}, 1000)"
    ].join("\n")
    writeFileSync(mcpConfig, JSON.stringify([{
      server: "contained", command: process.execPath,
      args: [fileURLToPath(new URL("./release-contained-mcp.mjs", import.meta.url)), recording]
    }]))
    writeFileSync(join(recording, "cell.txt"), kind === "mcp"
      ? 'await ctx.call("wait", { seconds: 150, reason: "Installed MCP containment" }); ctx.done("finished")'
      : `await ctx.call("bash", ${JSON.stringify({
        mode: "unhermetic", interpreter: "node", script, cwd: root, timeoutMs: 120_000
      })}); ctx.done("finished")`)
    const launched = invoke("up", "busy", "-d")
    assert.equal(launched.value.detached, true)
    const owner = remember(records(join(recording, "processes.jsonl"))
      .find((entry) => entry.event === "start" && entry.ppid === launched.pid && entry.verb === "run")?.pid)
    const ownedMcp = () => {
      const spawned = ledger().filter((entry) =>
        entry.kind === "flows.host.process-spawned.v1" && entry.payload.ownerPid === owner)
      return mcpProcesses().find((entry) => spawned.some((event) => event.payload.pid === entry.supervisor))
    }
    await waitFor(() => kind === "mcp" ? ownedMcp() !== undefined : existsSync(marker),
      "the real child under its recorded supervisor", 30_000)
    const child = remember(kind === "mcp" ? ownedMcp().pid : Number(readFileSync(marker, "utf8")))
    const supervisor = remember(parentPid(child))
    assert.notEqual(supervisor, owner)
    assert.equal(parentPid(supervisor), owner)
    assert.equal(processState(child)?.group, supervisor)
    assert.equal(processState(supervisor)?.group, supervisor)
    const childEvents = () => ledger().filter((entry) =>
      entry.payload.pid === supervisor && entry.payload.ownerPid === owner)
    const spawned = childEvents()
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].kind, "flows.host.process-spawned.v1")
    assert.equal(spawned[0].payload.pgid, supervisor)

    // A replacement composition may inspect the ledger, but cannot reap a
    // living owner's group. Completed commands must clean up their own MCPs.
    invoke("plan", "done")
    assert.ok(isAlive(owner) && isAlive(child), "A live owner's child was reaped")
    assert.equal(parentPid(child), supervisor)
    assert.equal(parentPid(supervisor), owner)
    assertCompletedMcps(supervisor)
    assert.equal(childEvents().length, 1)
    if (recovery === "reaper") {
      // Freeze only the supervisor, leaving the stubborn target running. This
      // prevents automatic EOF cleanup and forces real durable reaper work.
      signalOwned(supervisor, "SIGSTOP")
      await waitFor(() => processState(supervisor)?.stopped === true, "the supervisor to stop")
    }
    signalOwned(owner, "SIGKILL")
    await waitFor(() => !isAlive(owner), "the crashed owner to disappear")
    if (recovery === "automatic") {
      await waitFor(() => !isAlive(child) && !isAlive(supervisor), "automatic crash cleanup before replacement startup")
    } else {
      assert.ok(isAlive(child) && isAlive(supervisor), "The injected crash did not leave a real orphan group")
      assert.equal(parentPid(child), supervisor)
      await waitFor(() => parentPid(supervisor) !== owner, "the stopped supervisor to be reparented")
    }
    invoke("plan", "done")
    assertCompletedMcps(supervisor)
    assert.equal(isAlive(child), false, "Installed CLI left the orphan alive")
    assert.equal(isAlive(supervisor), false, "Installed CLI left the supervisor alive")
    const events = childEvents()
    assert.deepEqual(events.map((entry) => entry.kind), [
      "flows.host.process-spawned.v1",
      recovery === "automatic" ? "flows.host.process-reap-skipped.v1" : "flows.host.process-reaped.v1"
    ])
    if (recovery === "automatic") assert.equal(events[1].payload.reason, "process-gone")
    assert.equal(records(join(recording, "requests.jsonl")).length, 1)
    console.log(`Installed ${format} CLI ${kind} ${recovery} containment passed`)
  } catch (error) {
    testError = error
    throw error
  } finally {
    const cleanupErrors = []
    const signalled = []
    try { captureRecorded() } catch (error) { cleanupErrors.push(error) }
    // Signal every owned process before waiting. A killed target can remain a
    // zombie while its supervisor is stopped and cannot reap it yet.
    for (const [pid, startedAtMs] of owned) {
      try {
        const current = ProcessReaper.posixSystem.startedAtMs(pid)
        if (current._tag !== "started" || current.startedAtMs !== startedAtMs) continue
        signalled.push(pid)
        try { process.kill(pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
      } catch (error) { cleanupErrors.push(error) }
    }
    const settled = await Promise.allSettled(signalled.map((pid) =>
      waitFor(() => !isAlive(pid), `test-owned PID ${pid} cleanup`)))
    for (const result of settled) if (result.status === "rejected") cleanupErrors.push(result.reason)
    try { rmSync(root, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(testError === undefined ? cleanupErrors : [testError, ...cleanupErrors],
        `Installed ${format} ${kind} ${recovery} fixture cleanup failed`)
    }
  }
}

for (const kind of ["shell", "mcp"]) {
  for (const recovery of ["automatic", "reaper"]) await containment(kind, recovery)
}
