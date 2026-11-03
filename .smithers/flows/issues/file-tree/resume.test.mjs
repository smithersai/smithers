/**
 * `issues/file-tree` run for real with this checkout's CLI (`pnpm exec smthrs flow start`, state in `.flows/`) against
 * a fake smithers.sh, and killed twice: in the durable sleep between a create and its attach, and right after a send
 * whose answer never came back. Each time `smthrs runs resume` must carry on: no write made twice, every attach done.
 * A source checkout's CLI takes minutes to load the flows on a busy host, so its windows are long.
 */
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { startFakeSmithers } from "./fake-smithers.mjs"

const root = fileURLToPath(new URL("../../../../", import.meta.url))

const rows = () => {
  const node = (key, title, parent, depth) => ({ type: "node", key, repo: "acme/plan", title, about: `${title}.`, parent, depth, labels: [] })
  const issue = (key, title, repo) => ({ type: "issue", kind: "draft", key, repo, title, body: `${title}.`, labels: [], links: [{ kind: "session", ref: `lane:${key.replace(/\W/g, "-")}` }], parent: "tree:a", depth: 3 })
  return [
    node("tree:root", "Ship it", undefined, 1),
    node("tree:a", "Part A", "tree:root", 2),
    issue("draft:x:1", "First thing", "acme/plan"),
    issue("draft:x:2", "Second thing", "acme/code"),
    issue("draft:x:3", "Third thing", "acme/plan"),
    { type: "summary", at: "2026-11-02T00:00:00.000Z", maxDepth: 3 },
  ]
}

const smthrs = (args, env) => {
  const child = spawn("pnpm", ["exec", "smthrs", ...args], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout.on("data", (chunk) => (output += chunk))
  child.stderr.on("data", (chunk) => (output += chunk))
  let finished = false
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => { finished = true; resolve({ code, signal }) }))
  return { kill: () => { try { process.kill(-child.pid, "SIGKILL") } catch {} }, exited, output: () => output, done: () => finished }
}
const until = async (check, what, ms = 600_000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}
const latestRun = (env) => {
  const listed = spawnSync("pnpm", ["exec", "smthrs", "runs", "list", "--flow", "issues/file-tree", "--sort", "newest", "--limit", "5", "--json"], { cwd: root, env, encoding: "utf8", timeout: 300_000 })
  assert.equal(listed.status, 0, listed.stdout + listed.stderr)
  const id = /"runId":\s*"([^"]+)"/.exec(listed.stdout)?.[1]
  assert.ok(id !== undefined, `no run listed: ${listed.stdout.slice(0, 2000)}`)
  return id
}

test("a run killed between a create and its attach, and right after a send, resumes with nothing made twice", { timeout: 3_000_000 }, async () => {
  const fake = await startFakeSmithers()
  const dir = mkdtempSync(join(tmpdir(), "file-tree-resume-"))
  try {
    const tokens = {}
    for (const [repo, token] of [["acme/plan", `smm_${"p".repeat(43)}`], ["acme/code", `smm_${"c".repeat(43)}`]]) {
      const file = join(dir, token)
      writeFileSync(file, `${token}\n`, { mode: 0o600 })
      tokens[repo] = { file, agent: "filer", lane: "lane-1" }
    }
    const map = join(dir, "tokens.json")
    writeFileSync(map, JSON.stringify(tokens), { mode: 0o600 })
    const plan = join(dir, "plan.jsonl")
    writeFileSync(plan, rows().map((row) => JSON.stringify(row)).join("\n") + "\n")
    const env = { ...process.env, SMITHERS_ISSUE_TOKENS: map }
    const data = { plan, origin: fake.origin }
    const issues = () => [...fake.writes.values()].filter((write) => write.op === "issue/create")
    const relates = () => [...fake.writes.values()].filter((write) => write.op === "issue/relate")

    // 1. Killed once the first issue's create was submitted, before its attach (a watch's durable sleep is next).
    const first = smthrs(["flow", "start", "issues/file-tree", "--data", JSON.stringify(data), "--wait", "--json"], env)
    await until(() => issues().length === 3 || first.done(), "the first issue's create")
    first.kill()
    await first.exited
    assert.equal(issues().length, 3, first.output().slice(-2000))
    assert.equal(relates().filter((write) => write.number === 3).length, 0, "killed before the first issue's attach")
    const run = latestRun(env)

    // 2. Resumed, then killed right after the second issue's create was made, before its answer came back.
    const gate = fake.hold((method, path) => method === "POST" && path === "/api/repos/acme/code/writes")
    const second = smthrs(["runs", "resume", run, "--json"], env)
    await gate.came
    second.kill()
    await second.exited
    const heldSentBeforeKill = new Set(fake.submissions.keys())
    gate.release()
    assert.equal(issues().length, 4)

    // 3. Resumed to the end.
    const last = smthrs(["runs", "resume", run, "--json"], env)
    await until(() => fake.links.size === 3 || last.done(), "the run's end").catch((error) => {
      throw new Error(`${error.message}\nOUTPUT ${last.output().slice(-3000)}\nLOG ${JSON.stringify(fake.log.slice(-8))}`)
    })
    await last.exited
    assert.equal(fake.links.size, 3, last.output().slice(-3000))

    const keys = issues().map((write) => /^key: (\S+)\s*$/m.exec(write.body)?.[1])
    assert.deepEqual([...keys].sort(), ["draft:x:1", "draft:x:2", "draft:x:3", "tree:a", "tree:root"], "one issue per key")
    assert.equal(relates().length, 4, "every attach done, once")
    // The kill cut off the second issue's answer. The server had made it, so the resumed run found it by its key and
    // sent nothing again: one send, made before the kill, and one issue.
    const held = [...fake.writes.entries()].find(([, write]) => write.op === "issue/create" && write.repo === "acme/code")
    assert.ok(held !== undefined)
    console.log(`RESENT ${held[0]} sends=${fake.submissions.get(held[0])} firstBeforeKill=${heldSentBeforeKill.has(held[0])} issuesForKey=${keys.filter((key) => key === "draft:x:2").length}`)
    assert.equal(fake.submissions.get(held[0]), 1, "found by its key after the kill, not sent again")
    assert.ok(heldSentBeforeKill.has(held[0]), "first sent before the kill")
    assert.equal(keys.filter((key) => key === "draft:x:2").length, 1, "one issue for it")
  } finally {
    await fake.close()
  }
})

test("a resume while another drives the run is refused, and every write is sent once", { timeout: 3_000_000 }, async () => {
  const fake = await startFakeSmithers()
  const dir = mkdtempSync(join(tmpdir(), "file-tree-race-"))
  try {
    const tokens = {}
    for (const [repo, token] of [["acme/plan", `smm_${"p".repeat(43)}`], ["acme/code", `smm_${"c".repeat(43)}`]]) {
      const file = join(dir, token)
      writeFileSync(file, `${token}\n`, { mode: 0o600 })
      tokens[repo] = { file, agent: "filer", lane: "lane-1" }
    }
    const map = join(dir, "tokens.json")
    writeFileSync(map, JSON.stringify(tokens), { mode: 0o600 })
    const plan = join(dir, "plan.jsonl")
    writeFileSync(plan, rows().map((row) => JSON.stringify(row)).join("\n") + "\n")
    const env = { ...process.env, SMITHERS_ISSUE_TOKENS: map }
    const issues = () => [...fake.writes.values()].filter((write) => write.op === "issue/create")
    const relates = () => [...fake.writes.values()].filter((write) => write.op === "issue/relate")

    const first = smthrs(["flow", "start", "issues/file-tree", "--data", JSON.stringify({ plan, origin: fake.origin }), "--wait", "--json"], env)
    await until(() => issues().length === 3 || first.done(), "the first issue's create")
    first.kill()
    await first.exited
    const run = latestRun(env)
    const posted = fake.posts(/\/writes$/).length
    const sentBefore = new Set(fake.submissions.keys())

    // The first resume drives the run, held at its next send, while the second asks: a live driver, so it is refused.
    const gate = fake.hold((method, path) => method === "POST" && /\/writes$/.test(path))
    const driver = smthrs(["runs", "resume", run, "--json"], env)
    await gate.came
    const second = smthrs(["runs", "resume", run, "--json"], env)
    const secondExit = await second.exited
    gate.release()
    const racers = [driver, second]
    const exits = [await driver.exited, secondExit]
    const outputs = racers.map((racer) => racer.output())
    await until(() => fake.links.size === 3, "the run's end").catch((error) => {
      throw new Error(`${error.message}\nEXITS ${JSON.stringify(exits)}\nA ${outputs[0].slice(-2500)}\nB ${outputs[1].slice(-2500)}`)
    })

    const keys = issues().map((write) => /^key: (\S+)\s*$/m.exec(write.body)?.[1])
    assert.deepEqual([...keys].sort(), ["draft:x:1", "draft:x:2", "draft:x:3", "tree:a", "tree:root"], "one issue per key")
    assert.equal(relates().length, 4, "every attach done, once")
    // One resume drives the run; the other is told the run is not its.
    assert.equal(outputs.filter((text) => /"_tag":\s*"Accepted"/.test(text) && /"status":\s*"completed"/.test(text)).length, 1, `A ${outputs[0].slice(-1500)}\nB ${outputs[1].slice(-1500)}`)
    assert.equal(outputs.filter((text) => /"code":\s*"ClaimLost"/.test(text)).length, 1, `A ${outputs[0].slice(-1500)}\nB ${outputs[1].slice(-1500)}`)
    // A second driver would submit the writes it ran a second time: each write id is sent once.
    // A write sent again is only one whose answer the kill cut off: sent before the kill, and still one write. A second
    // driver would send again what was first sent after it.
    const again = [...fake.submissions.entries()].filter(([, count]) => count > 1)
    for (const [id, count] of again) console.log(`RESENT ${id} sends=${count} firstBeforeKill=${sentBefore.has(id)} issueForIt=${fake.writes.has(id)}`)
    assert.deepEqual(again.filter(([id, count]) => !sentBefore.has(id) || count > 2), [], `${posted} sends before the kill; sent again: ${JSON.stringify(again)}`)
    console.log(`RACE exits ${JSON.stringify(exits)}`)
  } finally {
    await fake.close()
  }
})
