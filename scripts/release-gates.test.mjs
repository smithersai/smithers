import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import { commandCovers, releaseGateArgs, releaseGateCommand, releaseGateExclusions, releaseGates } from "./release-gates.mjs"
import { repoRoot } from "./workspace-packages.mjs"

const workflow = (name) => readFileSync(join(repoRoot, ".github", "workflows", name), "utf8")

/** Every build-graph invocation one job makes, in order, comments dropped. */
const jobCommands = (source, job) => {
  const lines = source.split("\n").filter((line) => line.trim() !== "" && !/^\s*#/.test(line))
  const start = lines.indexOf(`  ${job}:`)
  assert.notEqual(start, -1, `${job} is not a job in this workflow`)
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line))
  return lines.slice(start, end === -1 ? lines.length : end)
    .flatMap((line) => [...line.matchAll(/pnpm exec (?:smithers-build|smthrs) [^\n]+/g)].map((match) => match[0]))
}

const jobs = (source) => [...source.slice(source.indexOf("\njobs:\n")).matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((match) => match[1])

test("the inventory names the exclusive fault matrix, serial, and the WASM byte-compare", () => {
  // These are the two gates ordinary `ci '//packages/...'` never runs and the
  // root release flow used to omit. Pinning them here means a future edit to
  // the inventory cannot drop them without failing this case.
  assert.deepEqual(releaseGates.filter((gate) => gate.target === "//packages/...:faults").map(releaseGateArgs), [
    ["test", "//packages/...:faults", "--jobs", "1", "--verbose"]
  ])
  assert.deepEqual(releaseGates.filter((gate) => gate.target === "//crates/flows-jj:wasmReproducibility").map(releaseGateArgs), [
    ["test", "//crates/flows-jj:wasmReproducibility", "--verbose"]
  ])
  const scriptSuites = releaseGates.filter((gate) => gate.target.startsWith("//scripts:")).map((gate) => gate.target)
  assert.deepEqual(scriptSuites, ["//scripts:packManifest", "//scripts:releaseVersion", "//scripts:releaseRehearsal", "//scripts:releaseCut"])
  const names = releaseGates.map((gate) => gate.name)
  assert.deepEqual(names, [...new Set(names)], "gate names are unique")
})

test("every inventory gate release.yml is expected to run appears in its publish job", () => {
  // release.yml is hand-written and cannot import the inventory, so this reads
  // the workflow and proves each command is present, either verbatim or under a
  // recursive selection such as `//scripts/...`. A gate with an explicit
  // `--jobs` bound must appear with that bound: the serial fault matrix is a
  // different proof from a parallel one.
  const commands = jobCommands(workflow("release.yml"), "publish")
  const missing = releaseGates
    .filter((gate) => gate.flowOnly === undefined)
    .filter((gate) => !commands.some((command) => commandCovers(command, gate)))
    .map(releaseGateCommand)
  assert.deepEqual(missing, [], "release.yml lacks these inventory gates")
  // Ordering: the fault matrix and the byte-compare both precede the build.
  const release = workflow("release.yml")
  const build = release.indexOf("scripts/build-release.mjs")
  assert.ok(build > 0)
  for (const target of ["//packages/...:faults", "//crates/flows-jj:wasmReproducibility"]) {
    const at = release.indexOf(`'${target}'`)
    assert.ok(at >= 0 && at < build, `${target} runs before the build in release.yml`)
  }
})

test("flow-only gates are the root flows' own targets, which no CI job runs", () => {
  // The flow gates its own sources. If ci.yml ever gains a flows job, the
  // release should mirror it and these entries should lose their exemption.
  const flowOnly = releaseGates.filter((gate) => gate.flowOnly !== undefined).map((gate) => gate.target)
  assert.deepEqual(flowOnly, ["//flows:check", "//flows:suite"])
  const ci = workflow("ci.yml")
  for (const target of flowOnly) assert.equal(ci.includes(`'${target}'`), false, `${target} is now a CI gate; drop its flowOnly exemption`)
})

test("the documented exclusions are real CI jobs and none of their gates leaked into the inventory", () => {
  const ci = workflow("ci.yml")
  const declared = jobs(ci)
  for (const { job, reason } of releaseGateExclusions) {
    assert.ok(declared.includes(job), `${job} is not a ci.yml job: ${reason}`)
    for (const command of jobCommands(ci, job)) {
      assert.equal(releaseGates.some((gate) => commandCovers(command, gate)), false, `${command} belongs to excluded job ${job}`)
    }
  }
})

test("commandCovers matches exact targets, recursive selections and job bounds only", () => {
  const gate = { name: "x", verb: "test", target: "//scripts:releaseCut" }
  assert.equal(commandCovers("pnpm exec smthrs test '//scripts:releaseCut' --verbose", gate), true)
  assert.equal(commandCovers("pnpm exec smthrs test '//scripts/...' --verbose", gate), true)
  assert.equal(commandCovers("pnpm exec smthrs test '//script/...' --verbose", gate), false)
  assert.equal(commandCovers("pnpm exec smthrs ci '//scripts/...' --verbose", gate), false)
  const serial = { name: "y", verb: "test", target: "//packages/...:faults", jobs: 1 }
  assert.equal(commandCovers("pnpm exec smthrs test '//packages/...:faults' --jobs 1 --verbose", serial), true)
  assert.equal(commandCovers("pnpm exec smthrs test '//packages/...:faults' --verbose", serial), false)
  assert.equal(commandCovers("pnpm exec smthrs test '//packages/...:faults' --jobs 2 --verbose", serial), false)
  assert.equal(commandCovers("pnpm exec smthrs test '//packages/...' --jobs 1 --verbose", serial), false)
})
