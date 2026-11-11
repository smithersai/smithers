import { Effect, Exit, Schema } from "effect"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { commandRunner, type RunCommand } from "../release-support/io.ts"
import { refreshReleaseLockfiles } from "../release-support/operations.ts"
import { GateEvidence } from "../release-support/schema.ts"
import { type ReleaseGateSet, runReleaseGates } from "../release/gates/flow.ts"
import { releaseGateArgs, releaseGateCommand, releaseGates } from "../release/release-gates.mjs"

// The real command runner launches a verifier that reads and advances a disk
// journal. It checks each argv against the gate the journal expects next and
// exits non-zero for the gates listed as red. No canned command results are used.
const fixture = async (t: TestContext, gates: ReleaseGateSet, red: ReadonlyArray<number> = []) => {
  const root = await mkdtemp(join(import.meta.dirname, ".gate-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const expected = gates.inventory.map((gate) => ["pnpm", "exec", "smthrs", ...releaseGateArgs(gate)])
  await writeFile(join(root, "expected.json"), JSON.stringify(expected))
  await writeFile(join(root, "completed.json"), "[]")
  await writeFile(join(root, "attempted.json"), "[]")
  await writeFile(
    join(root, "verify.mjs"),
    `
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
const expected = JSON.parse(readFileSync("expected.json", "utf8"))
const completed = JSON.parse(readFileSync("completed.json", "utf8"))
const attempted = JSON.parse(readFileSync("attempted.json", "utf8"))
assert.deepEqual(process.argv.slice(2), expected[attempted.length])
const red = ${JSON.stringify(red)}.includes(attempted.length)
attempted.push(process.argv.slice(2))
writeFileSync("attempted.json", JSON.stringify(attempted))
assert.equal(red, false, "gate verification failed")
completed.push(process.argv.slice(2))
writeFileSync("completed.json", JSON.stringify(completed))
`
  )
  const runner = commandRunner(root)
  const run: RunCommand = (command, args, options) =>
    runner(process.execPath, ["verify.mjs", command, ...args], options)
  const completed = async () => JSON.parse(await readFile(join(root, "completed.json"), "utf8")) as string[][]
  const attempted = async () => JSON.parse(await readFile(join(root, "attempted.json"), "utf8")) as string[][]
  return { run, completed, attempted, expected }
}

test("real release gate processes complete the full inventory in order before issuing a receipt", async (t) => {
  const gates = { inventory: releaseGates, exceptions: [] }
  const state = await fixture(t, gates)
  const receipt = await Effect.runPromise(runReleaseGates(state.run, gates))
  assert.deepEqual(await state.completed(), state.expected)
  assert.deepEqual(Schema.decodeUnknownSync(GateEvidence)(receipt), {
    ran: releaseGates.map((gate) => gate.name),
    exceptions: []
  })
})

test("a pending process completion blocks later gates and exceptions survive schema encoding", async (t) => {
  const [first, skipped, last] = releaseGates
  assert.ok(first && skipped && last)
  const exception = {
    name: skipped.name,
    command: releaseGateCommand(skipped),
    reason: "Fixture host has no runner container image store."
  }
  const gates = { inventory: [first, last], exceptions: [exception] }
  const state = await fixture(t, gates)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  t.after(() => release.resolve())
  let calls = 0
  const result = Effect.runPromise(runReleaseGates(async (command, args, options) => {
    calls++
    const output = await state.run(command, args, options)
    if (calls === 1) {
      entered.resolve()
      await release.promise
    }
    return output
  }, gates))
  await Promise.race([entered.promise, result.then(() => assert.fail("receipt issued before first completion"))])
  assert.equal(calls, 1)
  assert.deepEqual(await state.completed(), state.expected.slice(0, 1))
  release.resolve()
  const receipt = await result
  assert.deepEqual(await state.completed(), state.expected)
  assert.deepEqual(Schema.decodeUnknownSync(GateEvidence)(JSON.parse(JSON.stringify(receipt))), {
    ran: [first.name, last.name],
    exceptions: [exception]
  })
  assert.equal(receipt.ran.includes(skipped.name), false)
})

test("a red gate does not stop later gates, and the run fails naming every red gate with no receipt", async (t) => {
  const gates = { inventory: releaseGates.slice(0, 4), exceptions: [] }
  const state = await fixture(t, gates, [1, 3])
  const exit = await Effect.runPromiseExit(runReleaseGates(state.run, gates))
  assert.deepEqual(await state.attempted(), state.expected, "every gate runs after a red one")
  assert.deepEqual(await state.completed(), [state.expected[0], state.expected[2]])
  assert.ok(Exit.isFailure(exit))
  const failure = JSON.stringify(exit.cause)
  assert.match(failure, /release\/GatesFailed/)
  assert.ok(failure.includes(JSON.stringify([releaseGates[1]!.name, releaseGates[3]!.name])), failure)
})

test("interrupting the run stops the gate in flight and starts no later gate", async () => {
  const gates = { inventory: releaseGates.slice(0, 3), exceptions: [] }
  const entered = Promise.withResolvers<void>()
  const controller = new AbortController()
  let calls = 0
  const exit = Effect.runPromiseExit(
    runReleaseGates((_command, _args, options) => {
      calls++
      entered.resolve()
      // A gate that runs until it is stopped: the real runner over a sleeping child.
      return commandRunner(import.meta.dirname)(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], options)
    }, gates),
    { signal: controller.signal }
  )
  await entered.promise
  controller.abort()
  assert.ok(Exit.hasInterrupts(await exit))
  assert.equal(calls, 1, "an interrupted gate is not red, so no later gate starts")
})

test("release preparation keeps pnpm selectors npm-compatible and both frozen installs usable", {
  timeout: 120_000
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "release-locks-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = commandRunner(root)
  const opts = { signal: t.signal }
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "release-locks-fixture",
      private: true,
      dependencies: { effect: "4.0.5" }
    }) + "\n"
  )
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n")
  await run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], opts)
  await run("bun", ["install", "--lockfile-only", "--ignore-scripts"], opts)
  const workspace = "packages: []\noverrides:\n  \"a@1>b\": \"2.0.0\"\n  \"@scope/a@1>@other/b\": \"3.0.0\"\n"
  await writeFile(join(root, "pnpm-workspace.yaml"), workspace)

  await refreshReleaseLockfiles(root, run, t.signal)

  assert.match(await run("npx", ["--offline", "--call", "node --version"], opts), /^v\d+/)
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  assert.deepEqual(manifest.overrides, {
    "a@1": { b: "2.0.0" },
    "@scope/a@1": { "@other/b": "3.0.0" }
  })
  assert.equal(await readFile(join(root, "pnpm-workspace.yaml"), "utf8"), workspace)
  const lock = await readFile(join(root, "pnpm-lock.yaml"), "utf8")
  await run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], opts)
  await run("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], opts)
  assert.equal(await readFile(join(root, "pnpm-lock.yaml"), "utf8"), lock)
})

test("release preparation restores the manifest and tracked lock when Bun removes an empty lock", {
  timeout: 120_000
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "release-empty-lock-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = commandRunner(root)
  const opts = { signal: t.signal }
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "release-locks-fixture",
      private: true,
      dependencies: { effect: "4.0.5" }
    }) + "\n"
  )
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n")
  await run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], opts)
  await run("bun", ["install", "--lockfile-only", "--ignore-scripts"], opts)
  const lock = await readFile(join(root, "bun.lock"), "utf8")
  const manifest = JSON.stringify({ name: "release-locks-fixture", private: true }) + "\n"
  await writeFile(join(root, "package.json"), manifest)
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\noverrides:\n  \"a@1>b\": \"2.0.0\"\n")

  await assert.rejects(refreshReleaseLockfiles(root, run, t.signal), /did not recreate the tracked bun.lock/)

  assert.equal(await readFile(join(root, "bun.lock"), "utf8"), lock)
  assert.equal(await readFile(join(root, "package.json"), "utf8"), manifest)
})
