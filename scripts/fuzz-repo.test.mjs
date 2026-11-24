import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { callsHeader } from "../packages/smithers/build/build-cli/scripts/build-observe.mjs"
import { ensureObserveCallsHeader, execAsync, outputLimit } from "./fuzz-repo.mjs"

const fixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "fuzz-repo-contract-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const tool = join(root, "scripts/fuzz-repo.mjs")
  const copies = [
    ["./fuzz-repo.mjs", "scripts/fuzz-repo.mjs"],
    ["../packages/repo-targets/scripts/workspace-root.mjs", "packages/repo-targets/scripts/workspace-root.mjs"]
  ]
  for (const [from, to] of copies) {
    mkdirSync(dirname(join(root, to)), { recursive: true })
    cpSync(fileURLToPath(new URL(from, import.meta.url)), join(root, to))
  }
  return { root, tool }
}

test("invalid numeric flags and unmatched filters fail before reporting passes", (t) => {
  const { tool } = fixture(t)
  for (
    const args of [
      ["--concurrency", "abc"],
      ["--concurrency=0"],
      ["--concurrency=1.5"],
      ["--executions"],
      ["--duration", "-1"],
      ["--seed", "9007199254740992"],
      ["--zig-runs", "nan"],
      ["--filter", "no-suite"]
    ]
  ) {
    const result = spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" })
    assert.equal(result.status, 1, args.join(" "))
    assert.match(result.stderr, /requires|No fuzz packages selected/)
    assert.doesNotMatch(result.stdout, /packages passed/)
  }
})

test("requested coverage fails closed for Bun and malformed summaries", (t) => {
  const { root, tool } = fixture(t)
  const bin = join(root, "bin")
  mkdirSync(bin)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root }
  for (
    const [pkg, manifest] of [
      ["apps/tui", { scripts: { test: "bun test" } }],
      ["packages/fixture", { devDependencies: { vitest: "0.0.0" } }]
    ]
  ) {
    const member = join(root, pkg)
    mkdirSync(member, { recursive: true })
    writeFileSync(join(member, "package.json"), JSON.stringify(manifest))
    writeFileSync(join(member, "input.fuzz.test.ts"), "")
  }
  writeFileSync(join(root, "apps/tui/bunfig.toml"), "[test]\ncoverage = true\n")
  writeFileSync(join(bin, "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  writeFileSync(
    join(bin, "pnpm"),
    `#!/usr/bin/env node
const { join } = require("node:path")
const { writeFileSync } = require("node:fs")
const directory = process.argv.find((arg) => arg.startsWith("--coverage.reportsDirectory=")).split("=")[1]
writeFileSync(join(directory, "coverage-summary.json"), '{"total":{"lines":{"total":"wrong"}}}')
`,
    { mode: 0o755 }
  )
  for (const pkg of ["apps/tui", "packages/fixture"]) {
    const run = spawnSync(process.execPath, [tool, "--coverage", "--concurrency=1", "--filter", pkg], {
      env,
      encoding: "utf8"
    })
    assert.equal(run.status, 1, run.stderr)
    assert.match(run.stdout, /missing coverage evidence/)
    assert.match(run.stdout, /0\/1 packages measured/)
    assert.match(run.stdout, /0\/1 packages passed/)
    assert.doesNotMatch(run.stdout, /100\.0% \(0\/0\)/)
  }
})

test("keeps bounded tails and early native summaries for multiple loud children", async () => {
  const replies = await Promise.all([3, 7].map((code) =>
    execAsync(
      process.execPath,
      [
        "-e",
        `
      process.stdout.write("Done 42 runs in 1 seconds\\n");
      process.stdout.write("X".repeat(200000) + "\\n");
      process.stderr.write("Y".repeat(200000) + "\\nlast failure line\\n");
      process.exitCode = ${code};
    `
      ],
      process.cwd(),
      process.env
    )
  ))
  for (const [index, reply] of replies.entries()) {
    assert.equal(reply.code, [3, 7][index])
    assert.ok(Buffer.byteLength(reply.stdout) <= outputLimit)
    assert.ok(Buffer.byteLength(reply.stderr) <= outputLimit)
    assert.match(reply.stderr, /last failure line\n$/)
    assert.equal(reply.summaries.libfuzzer, "Done 42 runs in 1 seconds")
  }
})

test("applies a deadline to a subprocess that never exits", async () => {
  const reply = await execAsync(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    process.cwd(),
    process.env,
    100
  )
  assert.equal(reply.code, 1)
  assert.equal(reply.diagnostic, "Timed out after 100ms")
})

// R2-Neon-D3-013: an existing .gen/calls.h was kept whatever it held, so the Zig suites fuzzed an old syscall table.
test("the observer's syscall header is written when missing, replaced when stale, and left alone when current", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-fuzz-header-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const header = join(directory, ".gen", "calls.h")
  const current = callsHeader()
  assert.match(current, /^#define LAST_KNOWN \d+$/m)

  await ensureObserveCallsHeader(directory)
  assert.equal(readFileSync(header, "utf8"), current)

  // The table as an earlier build-observe.mjs wrote it: one entry short.
  const stale = current.split("\n").filter((line, index, lines) => index !== lines.length >> 1).join("\n")
  assert.notEqual(stale, current)
  for (const old of [stale, "", "// calls.h of another checkout\n"]) {
    writeFileSync(header, old)
    await ensureObserveCallsHeader(directory)
    assert.equal(readFileSync(header, "utf8"), current)
  }

  // A current header is not rewritten, so a build keyed on its time is not invalidated.
  const long = new Date("2026-01-01T00:00:00Z")
  utimesSync(header, long, long)
  await ensureObserveCallsHeader(directory)
  assert.equal(statSync(header).mtimeMs, long.getTime())
  assert.equal(readFileSync(header, "utf8"), current)
})
