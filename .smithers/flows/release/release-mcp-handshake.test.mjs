import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { inc } from "semver"

import { EXPECTED_EFFECT_VERSION as pin } from "../../../packages/repo-targets/contracts/check-single-effect-version.mjs"
import { alive, exited } from "./fixtures/installed-consumer/process-state.mjs"
import {
  assertEffectFamilyAccepts,
  assertEffectFamilyInstalled,
  installedEffectFamily,
  mcpInitialize
} from "./release-mcp-handshake.mjs"

/**
 * A release after the tested one: what a caret edge resolves once upstream
 * publishes it. Derived from the pin so it stays later than, and inside the
 * caret range of, every pinned Effect release.
 */
const newer = inc(pin, "minor")
const escaped = (version) => version.replaceAll(".", "\\.")

const run = promisify(execFile)

const scratch = async (t, prefix) => {
  const root = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const write = async (path, contents) => {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, contents)
}

/** A stdio MCP server that answers `initialize` the way `smthrs --mcp` does. */
const server = (body) => `#!/usr/bin/env node
const { createInterface } = require("node:readline")
const version = require("../package.json").version
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  ${body}
})
`
const answering = server(`process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "notifications/message" }) + "\\n")
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: {}, serverInfo: { name: "fixture", version } } }) + "\\n")`)

test("answers initialize from a CLI installed out of its packed tarball into an empty project", async (t) => {
  const root = await scratch(t, "smthrs-mcp-handshake-")
  const source = join(root, "source")
  await write(join(source, "package.json"), JSON.stringify({ name: "fixture-cli", version: "9.8.7-rc.1", bin: { "fixture-cli": "./bin/cli.cjs" } }))
  await write(join(source, "bin/cli.cjs"), answering)
  const { stdout } = await run("npm", ["pack", "--silent", "--pack-destination", root], { cwd: source })
  const consumer = join(root, "consumer")
  await write(join(consumer, "package.json"), JSON.stringify({ private: true }))
  // An empty cache: nothing the workspace installed can satisfy the consumer.
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline", "--cache", join(root, "empty-cache"),
    join(root, stdout.trim())], { cwd: consumer })
  const serverInfo = await mcpInitialize(join(consumer, "node_modules/.bin/fixture-cli"), ["--mcp"], { cwd: consumer, timeoutMs: 30_000 })
  assert.deepEqual(serverInfo, { name: "fixture", version: "9.8.7-rc.1" })
})

test("rejects every way a server can fail the handshake, with its stderr", async (t) => {
  const root = await scratch(t, "smthrs-mcp-failures-")
  await write(join(root, "package.json"), JSON.stringify({ version: "1.0.0" }))
  const cases = [
    // What smithers-orchestrator@0.32.0 did under a drifted Effect install.
    ["exits", `console.error("error: Cannot find module 'effect/process/ChildProcess'"); process.exit(1)`,
      /exited with 1 before answering initialize[\s\S]*effect\/process\/ChildProcess/],
    ["error reply", `process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "boom" } }) + "\\n")`,
      /MCP initialize failed: \{"code":-32603,"message":"boom"\}/],
    ["no serverInfo", `process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n")`,
      /answered without serverInfo\.version/],
    ["non-JSON", `process.stdout.write("Listening on stdio\\n")`, /non-JSON line: Listening on stdio/],
    ["silent", `console.error("still starting")`, /timed out after 500 ms[\s\S]*still starting/]
  ]
  for (const [name, body, expected] of cases) {
    const script = join(root, "bin", `${name.replace(/\W/g, "-")}.cjs`)
    await write(script, server(body))
    await assert.rejects(mcpInitialize(process.execPath, [script], { cwd: root, timeoutMs: 500 }), expected, name)
  }
  await assert.rejects(mcpInitialize(join(root, "missing-binary"), [], { cwd: root }), /MCP server could not start/)
})

/**
 * A server that starts one long-lived process on its own stdout and stderr,
 * records that process's pid, then runs `body` for the request.
 */
const serverWithDescendant = (pidFile, body) =>
  server(`const { spawn } = require("node:child_process")
  const { writeFileSync } = require("node:fs")
  const descendant = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] })
  writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid))
  ${body}`)

test("every settlement kills what the server started and closes the pipes it inherited", async (t) => {
  const root = await scratch(t, "smthrs-mcp-descendants-")
  await write(join(root, "package.json"), JSON.stringify({ version: "1.0.0" }))
  const descendants = []
  t.after(() => {
    for (const pid of descendants) if (alive(pid)) process.kill(pid, "SIGKILL")
  })
  const probe = async (name, body, timeoutMs) => {
    const pidFile = join(root, `${name}.pid`)
    const script = join(root, "bin", `${name}.cjs`)
    await write(script, serverWithDescendant(pidFile, body))
    const started = Date.now()
    const outcome = await mcpInitialize(process.execPath, [script], { cwd: root, timeoutMs })
      .then((serverInfo) => ({ serverInfo }), (error) => ({ error }))
    const pid = Number(await readFile(pidFile, "utf8"))
    descendants.push(pid)
    return { ...outcome, elapsed: Date.now() - started, pid }
  }
  // The reply settles the probe at once, while the descendant still holds the output open.
  const answered = await probe(
    "answers",
    `process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { serverInfo: { name: "fixture", version } } }) + "\\n")`,
    5000
  )
  assert.deepEqual(answered.serverInfo, { name: "fixture", version: "1.0.0" })
  assert.ok(answered.elapsed < 5000, `settled after ${answered.elapsed} ms`)
  assert.equal(await exited(answered.pid), true)
  // A server that exits without answering leaves the descendant on the pipes:
  // the deadline ends the probe, with the server's last words.
  const gone = await probe("exits", `console.error("gone"); process.exit(1)`, 300)
  assert.match(gone.error.message, /timed out after 300 ms[\s\S]*gone/)
  assert.equal(await exited(gone.pid), true)
})

const effectPackage = async (directory, name, version) =>
  write(
    join(directory, "package.json"),
    // Every adapter on the Effect release line peers `effect` from its own version up.
    JSON.stringify({ name, version, ...(name === "effect" ? {} : { peerDependencies: { effect: "^" + version } }) })
  )

test("reads every Effect-family copy an npm-style nested tree resolved, once each", async (t) => {
  const root = await scratch(t, "smthrs-effect-npm-")
  const modules = join(root, "node_modules")
  await effectPackage(join(modules, "effect"), "effect", pin)
  await effectPackage(join(modules, "@effect/platform-node"), "@effect/platform-node", pin)
  // The #2398 shape: the adapter's caret edge nested a newer shared platform.
  await effectPackage(join(modules, "@effect/platform-node/node_modules/@effect/platform-node-shared"), "@effect/platform-node-shared", newer)
  await effectPackage(join(modules, "@effect/platform-node/node_modules/@effect/platform-node-shared/node_modules/effect"), "effect", newer)
  await effectPackage(join(modules, "unrelated"), "unrelated", "1.0.0")
  await mkdir(join(modules, ".bin"), { recursive: true })
  // A link to a copy already listed is the same copy.
  await mkdir(join(modules, "unrelated/node_modules"), { recursive: true })
  await symlink(join(modules, "effect"), join(modules, "unrelated/node_modules/effect"), "dir")
  assert.deepEqual(installedEffectFamily(root).map(({ name, version }) => `${name}@${version}`), [
    `@effect/platform-node@${pin}`,
    `@effect/platform-node-shared@${newer}`,
    `effect@${pin}`,
    `effect@${newer}`
  ])
  assert.throws(() => assertEffectFamilyInstalled(root, pin), (error) => {
    assert.match(error.message, new RegExp(`Consumer resolved Effect-family packages off ${escaped(pin)}`))
    assert.match(error.message, new RegExp(`@effect\\/platform-node-shared@${escaped(newer)} at `))
    assert.match(error.message, new RegExp(`effect@${escaped(newer)} at `))
    assert.doesNotMatch(error.message, /platform-node@/)
    return true
  })
  // The range rule refuses the same tree: a second Effect, and an adapter that
  // needs a later Effect than the one the application runs.
  assert.throws(() => assertEffectFamilyAccepts(root, pin), (error) => {
    assert.match(error.message, new RegExp(`do not accept effect@${escaped(pin)}`))
    assert.match(error.message, new RegExp(`@effect\\/platform-node-shared@${escaped(newer)} \\(peer effect \\^${escaped(newer)}\\) at `))
    assert.match(error.message, new RegExp(`effect@${escaped(newer)} at `))
    assert.doesNotMatch(error.message, /platform-node@/)
    return true
  })
})

test("an application on a later Effect keeps the adapters built for the tested release", async (t) => {
  const root = await scratch(t, "smthrs-effect-range-")
  const modules = join(root, "node_modules")
  // What `@smthrs/flows` plus `effect@latest` installs once upstream is ahead:
  // the application's Effect and its own adapter at the later release, and the
  // SQLite driver `@smthrs/flows` installs at the tested one.
  await effectPackage(join(modules, "effect"), "effect", newer)
  await effectPackage(join(modules, "@effect/platform-node"), "@effect/platform-node", newer)
  await effectPackage(join(modules, "@smthrs/flows/node_modules/@effect/sql-sqlite-node"), "@effect/sql-sqlite-node", pin)
  await write(join(modules, "@smthrs/flows/package.json"), JSON.stringify({ name: "@smthrs/flows", version: "1.0.0" }))
  assert.deepEqual(assertEffectFamilyAccepts(root, newer).map(({ name, version }) => `${name}@${version}`), [
    `@effect/platform-node@${newer}`,
    `@effect/sql-sqlite-node@${pin}`,
    `effect@${newer}`
  ])
  // The exact rule is the tested tree's, and this is not that tree.
  assert.throws(() => assertEffectFamilyInstalled(root, pin), /Consumer resolved Effect-family packages off/)
  // The installed Effect has to be the one the caller found.
  assert.throws(() => assertEffectFamilyAccepts(root, pin), new RegExp(`effect@${escaped(newer)} at `))
  // An adapter that states no Effect peer is refused, not assumed compatible.
  await write(
    join(modules, "@effect/opaque/package.json"),
    JSON.stringify({ name: "@effect/opaque", version: newer })
  )
  assert.throws(() => assertEffectFamilyAccepts(root, newer), new RegExp(`@effect\\/opaque@${escaped(newer)} \\(peer effect undeclared\\) at `))
})

test("reads a pnpm store and accepts a tree on the one family version", async (t) => {
  const root = await scratch(t, "smthrs-effect-pnpm-")
  const store = join(root, "node_modules/.pnpm")
  const effect = join(store, `effect@${pin}/node_modules/effect`)
  const shared = join(store, `@effect+platform-node-shared@${pin}_effect@${pin}/node_modules/@effect/platform-node-shared`)
  await effectPackage(effect, "effect", pin)
  await effectPackage(shared, "@effect/platform-node-shared", pin)
  await symlink(effect, join(store, `@effect+platform-node-shared@${pin}_effect@${pin}/node_modules/effect`), "dir")
  await mkdir(join(root, "node_modules/@effect"), { recursive: true })
  await symlink(shared, join(root, "node_modules/@effect/platform-node-shared"), "dir")
  await symlink(effect, join(root, "node_modules/effect"), "dir")
  await writeFile(join(store, "lock.yaml"), "")
  const installed = assertEffectFamilyInstalled(root, pin)
  assert.deepEqual(installed.map(({ name, version }) => `${name}@${version}`), [
    `@effect/platform-node-shared@${pin}`,
    `effect@${pin}`
  ])
  assert.deepEqual(assertEffectFamilyAccepts(root, pin), installed)
})

test("fails a consumer that resolved no effect at all", async (t) => {
  const root = await scratch(t, "smthrs-effect-empty-")
  assert.deepEqual(installedEffectFamily(root), [])
  await effectPackage(join(root, "node_modules/@effect/platform-node"), "@effect/platform-node", pin)
  assert.throws(() => assertEffectFamilyInstalled(root, pin), /no installed effect package/)
  assert.throws(() => assertEffectFamilyAccepts(root, pin), /no installed effect package/)
})
