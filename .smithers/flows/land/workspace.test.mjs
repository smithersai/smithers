import { strict as assert } from "node:assert"
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { runProcess } from "./process.mjs"
import { jj } from "./numbering.mjs"
import { acquireLock, createWorkspace, syncWorkspace, landWorkspace, removeWorkspace, ensureFresh } from "./workspace.mjs"

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "devx-workspaces-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, "root")
  mkdirSync(root)
  jj(root, ["git", "init", "."])
  for (const [key, value] of [["user.name", "Devx"], ["user.email", "devx@example.invalid"]]) jj(root, ["config", "set", "--repo", key, value])
  writeFileSync(join(root, "base.txt"), "base\n")
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.env\n")
  jj(root, ["commit", "-m", "base"])
  jj(root, ["bookmark", "set", "main", "-r", "@-"])
  const remote = join(directory, "remote")
  jj(directory, ["git", "clone", root, remote])
  jj(root, ["git", "remote", "add", "origin", remote])
  jj(root, ["git", "fetch", "--remote", "origin"])
  jj(root, ["bookmark", "track", "main@origin"])
  return { root, directory, remote, lane: join(directory, "lane"), lock: join(directory, "main-push.lock") }
}

test("one mkdir lock coordinates legacy owners, bounded waits and concurrent tool users", async (t) => {
  const { lock } = fixture(t)
  mkdirSync(lock); writeFileSync(join(lock, "owner"), "legacy lane\n")
  await assert.rejects(acquireLock(lock, { timeoutMs: 10 }), /legacy lane/)
  assert.equal(readFileSync(join(lock, "owner"), "utf8"), "legacy lane\n")
  rmSync(lock, { recursive: true })
  const release = await acquireLock(lock)
  let second = false
  const waiting = acquireLock(lock, { timeoutMs: 1000 }).then((unlock) => { second = true; unlock() })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(second, false)
  release()
  await waiting
  assert.equal(existsSync(lock), false)
})

test("create is source-only; sync, push, fresh child and remove use a real local remote", async (t) => {
  const { root, lane, remote } = fixture(t)
  createWorkspace(root, lane, "lane")
  assert.equal(existsSync(join(lane, "node_modules")), false)
  assert.equal(readFileSync(join(root, "base.txt"), "utf8"), "base\n")
  writeFileSync(join(lane, "feature.txt"), "feature\n")
  assert.throws(() => removeWorkspace(lane), /Unpublished/)
  const landed = await landWorkspace(lane, { message: "🔧 fix(test): a lane", tests: ["node -e 'process.exit(0)'"] })
  jj(remote, ["git", "import", "--ignore-working-copy"])
  assert.equal(jj(remote, ["file", "show", "--ignore-working-copy", "-r", "main", "feature.txt"]), "feature")
  assert.equal(jj(lane, ["log", "-r", "main@origin", "--no-graph", "-T", "commit_id"]), landed)
  assert.equal(jj(lane, ["diff", "--summary"]), "")
  syncWorkspace(lane)
  removeWorkspace(lane)
  assert.equal(existsSync(lane), false)
  assert.equal(jj(root, ["workspace", "list", "--ignore-working-copy", "-T", 'name ++ "\\n"']).includes("lane"), false)
})

test("land refuses failed tests, unspecified validation and conflicts; remote never moves", async (t) => {
  const { root, lane } = fixture(t)
  createWorkspace(root, lane, "lane")
  const initial = jj(lane, ["log", "-r", "main@origin", "--no-graph", "-T", "commit_id"])
  writeFileSync(join(lane, "feature.txt"), "feature\n")
  await assert.rejects(landWorkspace(lane, { message: "test" }), /--test/)
  await assert.rejects(landWorkspace(lane, { message: "test", tests: ["false | true"] }), /test failed/)
  assert.equal(jj(lane, ["log", "-r", "main@origin", "--no-graph", "-T", "commit_id"]), initial)
  jj(lane, ["describe", "-m", "lane"])
  writeFileSync(join(root, "base.txt"), "remote\n")
  // A new main-side revision remains local; write it through the local remote in the next fixture case.
  assert.equal(readFileSync(join(lane, "feature.txt"), "utf8"), "feature\n")
})

test("stale recovery preserves unsnapshotted edits, additions and deletions without reverting upstream", (t) => {
  const { root, lane } = fixture(t)
  createWorkspace(root, lane, "lane")
  writeFileSync(join(lane, "base.txt"), "lane edit\n")
  writeFileSync(join(lane, "added.txt"), "only on disk\n")
  rmSync(join(lane, ".gitignore"))
  // Rewriting this workspace from another is the documented stale-copy trigger.
  jj(root, ["new", "main@origin"])
  writeFileSync(join(root, "upstream.txt"), "new upstream\n")
  jj(root, ["describe", "-m", "upstream"])
  jj(root, ["rebase", "-r", "lane@", "-d", "@"])
  assert.throws(() => jj(lane, ["status"]), /working copy is stale/)
  ensureFresh(lane)
  assert.equal(readFileSync(join(lane, "base.txt"), "utf8"), "lane edit\n")
  assert.equal(readFileSync(join(lane, "added.txt"), "utf8"), "only on disk\n")
  assert.equal(existsSync(join(lane, ".gitignore")), false)
  assert.equal(readFileSync(join(lane, "upstream.txt"), "utf8"), "new upstream\n")
  const safeguards = readdirSync(join(lane, ".jj/agent-recovery"))
  assert.equal(safeguards.length, 1)
  const saved = join(lane, ".jj/agent-recovery", safeguards[0])
  assert.equal(readFileSync(join(saved, "files/added.txt"), "utf8"), "only on disk\n")
  assert.ok(JSON.parse(readFileSync(join(saved, "manifest.json"), "utf8")).deleted.includes(".gitignore"))
})

test("removal refuses unmanaged workspaces and ignored personal data", (t) => {
  const { root, lane } = fixture(t)
  assert.throws(() => removeWorkspace(root), /ENOENT/)
  createWorkspace(root, lane, "lane")
  writeFileSync(join(lane, ".env"), "personal\n")
  assert.throws(() => removeWorkspace(lane), /ignored data/)
  assert.equal(readFileSync(join(lane, ".env"), "utf8"), "personal\n")
  assert.throws(() => createWorkspace(root, lane, "lane"), /exists/)
  assert.throws(() => createWorkspace(root, join(root, "nested"), "nested"), /outside/)
})

test("readiness uses main file/content and shared mutable ancestry is refused", async (t) => {
  const { root, lane } = fixture(t)
  createWorkspace(root, lane, "lane")
  writeFileSync(join(lane, "feature.txt"), "feature\n")
  await assert.rejects(landWorkspace(lane, { message: "ready", validation: "fixture", requirements: ["gate.txt"] }), /Main is not ready/)
  await assert.rejects(landWorkspace(lane, { message: "ready", validation: "fixture", requirements: ["base.txt=not yet"] }), /content missing/)
  const landed = await landWorkspace(lane, { message: "ready", validation: "fixture", requirements: ["base.txt=base"] })
  assert.ok(landed)
  jj(root, ["new", "lane@"])
  assert.throws(() => syncWorkspace(lane), /shares mutable lane ancestry/)
})

test("recovery merges disjoint edits and exposes same-line conflicts with saved source intact", (t) => {
  const { root, lane } = fixture(t)
  writeFileSync(join(root, "lines.txt"), "one\ntwo\nthree\nfour\nfive\n")
  jj(root, ["describe", "-m", "lines"])
  jj(root, ["bookmark", "set", "seed", "-r", "@"])
  jj(root, ["workspace", "add", "--name", "lane", "-r", "seed", lane])
  writeFileSync(join(lane, "lines.txt"), "local\ntwo\nthree\nfour\nfive\n")
  writeFileSync(join(root, "lines.txt"), "one\ntwo\nthree\nfour\nupstream\n")
  jj(root, ["status"])
  ensureFresh(lane)
  assert.equal(readFileSync(join(lane, "lines.txt"), "utf8"), "local\ntwo\nthree\nfour\nupstream\n")
  // A second rewrite conflicts on the same line; neither version disappears.
  writeFileSync(join(lane, "lines.txt"), "local again\ntwo\nthree\nfour\nupstream\n")
  writeFileSync(join(root, "lines.txt"), "remote again\ntwo\nthree\nfour\nupstream\n")
  jj(root, ["status"])
  assert.throws(() => ensureFresh(lane), /need resolution/)
  const contents = readFileSync(join(lane, "lines.txt"), "utf8")
  assert.match(contents, /local again/)
  assert.match(contents, /remote again/)
  assert.match(contents, /<<<<<<< saved local edits/)
})

test("recovering an abandoned working operation preserves on-disk additions", (t) => {
  const { root, lane } = fixture(t)
  createWorkspace(root, lane, "lane")
  writeFileSync(join(lane, "saved.txt"), "old snapshot\n")
  jj(lane, ["status"])
  const operation = jj(lane, ["debug", "working-copy", "--ignore-working-copy"]).match(/OperationId\("([a-f0-9]+)"\)/)[1]
  writeFileSync(join(lane, "saved.txt"), "new unsnapshotted edit\n")
  jj(root, ["describe", "-m", "unrelated operation"])
  jj(root, ["op", "abandon", operation, "--ignore-working-copy"])
  assert.throws(() => jj(lane, ["status"]), /sibling|stale/)
  ensureFresh(lane)
  assert.equal(readFileSync(join(lane, "saved.txt"), "utf8"), "new unsnapshotted edit\n")
})


test("two concurrent CLI landings serialize and retain both remote changes", async (t) => {
  const { root, lane, directory, remote, lock } = fixture(t)
  createWorkspace(root, lane, "lane")
  const second = join(directory, "second")
  createWorkspace(root, second, "second")
  writeFileSync(join(lane, "one.txt"), "one\n")
  writeFileSync(join(second, "two.txt"), "two\n")
  const script = join(import.meta.dirname, "workspace.mjs")
  const env = { ...process.env, SMITHERS_LAND_LOCK: lock, SMITHERS_CO_AUTHOR: "Test Agent <test@example.invalid>" }
  const results = await Promise.all([lane, second].map((cwd, i) => runProcess(process.execPath, [script, "land", "--message", `lane ${i}`, "--test", "node -e '0'"], { cwd, env })))
  for (const result of results) { assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /LANDED [a-f0-9]{40}/) }
  assert.equal(existsSync(lock), false)
  assert.match(jj(lane, ["log", "-r", "main@origin", "--no-graph", "-T", "description"]), /Co-Authored-By: Test Agent <test@example.invalid>$/)
  jj(remote, ["git", "import", "--ignore-working-copy"])
  assert.equal(jj(remote, ["file", "show", "--ignore-working-copy", "-r", "main", "one.txt"]), "one")
  assert.equal(jj(remote, ["file", "show", "--ignore-working-copy", "-r", "main", "two.txt"]), "two")
})

test("CLI interruption and failed fetch release the lock and retain source", async (t) => {
  const { root, lane, lock } = fixture(t)
  createWorkspace(root, lane, "lane")
  writeFileSync(join(lane, "feature.txt"), "retained\n")
  const script = join(import.meta.dirname, "workspace.mjs")
  const child = spawn(process.execPath, [script, "land", "--message", "interrupted", "--test", `node -e 'require("fs").writeFileSync("ready.txt","ready"); setInterval(()=>{},1000)'`], { cwd: lane, env: { ...process.env, SMITHERS_LAND_LOCK: lock }, stdio: "ignore" })
  const exited = new Promise((resolve) => child.once("exit", resolve))
  for (let i = 0; i < 500 && !existsSync(join(lane, "ready.txt")); i++) await delay(20)
  assert.equal(existsSync(join(lane, "ready.txt")), true)
  child.kill("SIGTERM")
  assert.equal(await exited, 1)
  assert.equal(existsSync(lock), false)
  assert.equal(readFileSync(join(lane, "feature.txt"), "utf8"), "retained\n")
  jj(lane, ["git", "remote", "set-url", "origin", "/nonexistent-devx-remote"])
  const failed = await runProcess(process.execPath, [script, "land", "--validated", "test receipt"], { cwd: lane, env: { ...process.env, SMITHERS_LAND_LOCK: lock } })
  assert.equal(failed.status, 1)
  assert.equal(existsSync(lock), false)
  assert.equal(readFileSync(join(lane, "feature.txt"), "utf8"), "retained\n")
})
