import { strict as assert } from "node:assert"
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, lstatSync, unlinkSync, rmdirSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { runProcess } from "./process.mjs"
import { jj } from "./numbering.mjs"
import { acquireLock, createWorkspace, syncWorkspace, landWorkspace as land, removeWorkspace, ensureFresh } from "./workspace.mjs"

const landWorkspace = (root, options) => land(root, { ...options, lockPath: join(dirname(root), "main-push.lock") })

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

test("sync refuses a working copy below the lane's top, before rewriting anything", (t) => {
  const { root } = fixture(t)
  writeFileSync(join(root, "first.txt"), "first\n")
  jj(root, ["commit", "-m", "first"])
  writeFileSync(join(root, "second.txt"), "second\n")
  jj(root, ["commit", "-m", "second"])
  jj(root, ["edit", "description(substring:first)"])
  const before = jj(root, ["log", "-r", "all()", "--no-graph", "-T", 'commit_id ++ "\\n"'])
  assert.throws(() => syncWorkspace(root), /lane's top/)
  assert.equal(jj(root, ["log", "-r", "all()", "--no-graph", "-T", 'commit_id ++ "\\n"']), before)
})

test("a regular file at the landing lock path is refused immediately and preserved", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "devx-lock-file-"))
  const lock = join(directory, "main-push.lock")
  writeFileSync(lock, "")
  t.after(() => { unlinkSync(lock); rmdirSync(directory) })
  const before = lstatSync(lock)
  const start = performance.now()
  const error = await acquireLock(lock, { timeoutMs: 1200 }).then(
    async (release) => { await release(); assert.fail("acquired a regular file lock") },
    (error) => error
  )
  assert.ok(performance.now() - start < 250, "refuse before waiting for the lock timeout")
  assert.ok(error.message.includes(lock), "error names the lock path")
  assert.match(error.message, /regular file.*not the directory form \(mkdir lock \+ owner\).*confirming no lander holds it/)
  assert.equal(lstatSync(lock).isFile(), true)
  assert.equal(lstatSync(lock).ino, before.ino)
  assert.equal(readFileSync(lock, "utf8"), "")
})

test("a symbolic link at the landing lock path is refused without touching its target", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "devx-lock-link-"))
  const lock = join(directory, "main-push.lock")
  const target = join(directory, "target")
  mkdirSync(target)
  writeFileSync(join(target, "owner"), "existing owner\n")
  symlinkSync(target, lock)
  t.after(() => { unlinkSync(lock); unlinkSync(join(target, "owner")); rmdirSync(target); rmdirSync(directory) })
  await assert.rejects(acquireLock(lock, { timeoutMs: 1200 }), (error) => {
    assert.ok(error.message.includes(lock))
    assert.match(error.message, /symbolic link.*not the directory form/)
    return true
  })
  assert.equal(lstatSync(lock).isSymbolicLink(), true)
  assert.equal(readFileSync(join(target, "owner"), "utf8"), "existing owner\n")
})

test("one mkdir lock coordinates legacy owners, bounded waits and concurrent tool users", async (t) => {
  const { lock } = fixture(t)
  mkdirSync(lock); writeFileSync(join(lock, "owner"), "legacy lane\n")
  await assert.rejects(acquireLock(lock, { timeoutMs: 10 }), /legacy lock/)
  assert.equal(readFileSync(join(lock, "owner"), "utf8"), "legacy lane\n")
  rmSync(lock, { recursive: true })
  const release = await acquireLock(lock)
  let second = false
  const queued = Promise.withResolvers()
  const waiting = acquireLock(lock, { timeoutMs: 10000, log: (line) => { if (line.includes("position 2")) queued.resolve() } }).then(async (unlock) => { second = true; await unlock() })
  await queued.promise
  assert.equal(second, false)
  await release()
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

test("land refuses source changed by a check and retains it without moving remote main", async (t) => {
  const { root, lane } = fixture(t)
  createWorkspace(root, lane, "lane")
  writeFileSync(join(lane, "feature.txt"), "before\n")
  const base = jj(lane, ["log", "-r", "main@origin", "--no-graph", "-T", "commit_id"])
  await assert.rejects(landWorkspace(lane, { message: "changed", tests: ['node -e \'require("fs").writeFileSync("feature.txt","after")\''] }), /Source changed during validation/)
  assert.equal(jj(lane, ["log", "-r", "main@origin", "--no-graph", "-T", "commit_id"]), base)
  assert.equal(readFileSync(join(lane, "feature.txt"), "utf8"), "after")
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
  const results = await Promise.all([lane, second].map(async (cwd, i) => {
    const args = [script, "land", "--message", `lane ${i}`, "--test", "node -e '0'"]
    const result = await runProcess(process.execPath, args, { cwd, env })
    if (result.status === 1 && /Main advanced during validation/.test(result.stderr)) return runProcess(process.execPath, args, { cwd, env })
    return result
  }))
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

test("disk-full fallback and validation retain the FIFO lease", async (t) => {
  const { root, lane, directory, lock } = fixture(t)
  mkdirSync(join(root, ".smithers"))
  writeFileSync(join(root, ".smithers/target-index.json"), "[]\n")
  writeFileSync(join(root, ".node-version"), "26.5.0\n")
  jj(root, ["describe", "-m", "index source"])
  jj(root, ["bookmark", "set", "main", "-r", "@"])
  jj(root, ["git", "push", "--remote", "origin", "--bookmark", "main"])
  // Independent fixture repository, without adding a jj workspace.
  jj(directory, ["git", "clone", root, lane])
  writeFileSync(join(lane, "one.txt"), "one\n")
  const mini = join(directory, "mini-run"), box = join(directory, "cfbox")
  writeFileSync(mini, `#!${process.execPath}\n
    require("node:assert/strict").equal(require("node:fs").existsSync(process.env.SMITHERS_LAND_LOCK), true)
    console.error("FARM_HEALTH DISK_FULL"); process.exit(73)
  `, { mode: 0o755 })
  writeFileSync(box, `#!${process.execPath}\n
    require("node:assert/strict").equal(require("node:fs").existsSync(process.env.SMITHERS_LAND_LOCK), true)
    console.log("SMITHERS_TARGET_INDEX " + Buffer.from('[{"label":"//:index"}]').toString("base64"))
  `, { mode: 0o755 })
  const script = join(import.meta.dirname, "workspace.mjs")
  const env = { ...process.env, SMITHERS_LAND_LOCK: lock, SMITHERS_MINI_RUN: mini, SMITHERS_CFBOX: box }
  const check = `node -e 'require("assert/strict").equal(require("fs").existsSync(process.env.SMITHERS_LAND_LOCK),true)'`
  const result = await runProcess(process.execPath, [script, "land", "--message", "first", "--test", check], { cwd: lane, env })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /TARGET_INDEX host=mini status=disk_full exit=73/)
  assert.equal(existsSync(lock), false)
  assert.equal(jj(lane, ["file", "show", "-r", "main@origin", "one.txt"]), "one")
})

test("removal refuses work the lane moved off @: a lane bookmark or a bare head", (t) => {
  const { root, lane } = fixture(t)
  createWorkspace(root, lane, "lane")
  writeFileSync(join(lane, "kept.txt"), "kept on a bookmark\n")
  jj(lane, ["commit", "-m", "bookmarked work"])
  jj(lane, ["bookmark", "set", "builder/lane", "-r", "@-"])
  jj(lane, ["new", "main@origin"])
  assert.throws(() => removeWorkspace(lane), /Unlanded work outside @[\s\S]*builder\/lane[\s\S]*bookmarked work/)
  jj(lane, ["bookmark", "delete", "builder/lane"])
  // Without the bookmark the commit is a bare head: still the lane's work.
  assert.throws(() => removeWorkspace(lane), /Unlanded work outside @[\s\S]*bookmarked work/)
  jj(lane, ["abandon", "description(substring:bookmarked)"])
  removeWorkspace(lane)
  assert.equal(existsSync(lane), false)
})
