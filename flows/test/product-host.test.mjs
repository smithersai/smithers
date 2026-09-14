import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import { execFileSync, spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
const artifact = resolve(process.env.SMITHERS_PRODUCT_HOST_ARTIFACT ?? "dist/product-host/smithers.mjs")
const runtime = process.env.SMITHERS_PRODUCT_HOST_RUNTIME ?? process.execPath
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim()

test("standalone product gateway executes real librarian flows, publishes before completion, and survives restart", { timeout: 180_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "product-gateway-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.invalid")
  await writeFile(join(root, "README.md"), "# Fixture\n")
  git(root, "add", "."); git(root, "commit", "-m", "Fixture")
  const sourceHead = git(root, "rev-parse", "HEAD")
  let published, failPublication = false
  const publisher = createServer(async (request, response) => {
    assert.equal(request.url, "/api/gateways/11111111-1111-4111-8111-111111111111/wiki-pages")
    assert.equal(request.headers.authorization, "Bearer fixture")
    let body = ""; for await (const part of request) body += part
    published = JSON.parse(body)
    response.writeHead(failPublication ? 503 : 200, { "content-type": "application/json" })
    response.end(JSON.stringify({ pages: published.pages.map(page => ({ id: page.id, slug: "source-fixture" })) }))
  })
  await new Promise(resolve => publisher.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => publisher.close(resolve)))
  const portServer = createServer(); await new Promise(resolve => portServer.listen(0, "127.0.0.1", resolve))
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve))
  const base = `http://127.0.0.1:${port}`
  let child, logs = ""
  const stop = async () => { if (child?.exitCode === null) { const stopped = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await stopped } }
  t.after(stop)
  const start = async () => {
    child = spawn(runtime, [artifact, "serve", "--root", root, "--port", String(port)], { cwd: root,
      env: { ...process.env, SMITHERS_API_KEY: "fixture", SMITHERS_GATEWAY_ID: "11111111-1111-4111-8111-111111111111",
        SMITHERS_REPO: "fixture/demo", SMITHERS_PRODUCT_API_URL: `http://127.0.0.1:${publisher.address().port}` }, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.on("data", data => { logs += data }); child.stderr.on("data", data => { logs += data })
    for (let i = 0; i < 300; i++) {
      if (child.exitCode !== null) throw new Error(logs)
      const health = await fetch(`${base}/health`).then(r => r.ok ? r.json() : undefined).catch(() => undefined)
      if (health) { assert.equal(health.protocolVersion, "1"); assert.deepEqual(health.capabilities, ["librarian/v1"]); return }
      await pause(100)
    }
    throw new Error(`Host did not listen: ${logs}`)
  }
  const rpc = async (tag, payload) => {
    const response = await fetch(`${base}/${tag.startsWith("Projection.") ? "projections" : "rpc"}`, {
      method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/ndjson" },
      body: JSON.stringify({ _tag: "Request", id: 1, tag, payload, headers: [] }) + "\n" })
    const text = await response.text()
    const result = text.trim().split("\n").map(JSON.parse).find(line => line._tag === "Exit")
    assert.equal(result?.exit._tag, "Success", text)
    return result.exit.value
  }
  const settled = async runId => {
    for (let i = 0; i < 300; i++) {
      const snapshot = await rpc("Projection.Snapshot", { selector: { _tag: "run-summary", runId } })
      const row = snapshot.rows[0]
      if (["completed", "failed", "cancelled"].includes(row?.status)) return row
      await pause(100)
    }
    throw new Error(`Run ${runId} did not settle: ${logs}`)
  }
  const run = async (kind, repo = "fixture/demo") => {
    const plan = await rpc("Plan", { flowId: `librarian/${kind}`, input: { repo, _librarian: { kind } } })
    await rpc("Approve", plan.approval)
    const receipt = await rpc("Run", { _tag: "Plan", planId: plan.planId, digest: plan.digest,
      envelope: plan.envelope, idempotencyKey: crypto.randomUUID() })
    assert.equal(receipt._tag, "Accepted")
    return settled(receipt.runId)
  }
  await start()
  const unauthorized = await fetch(`${base}/rpc`, { method: "POST", headers: { "content-type": "application/ndjson" },
    body: JSON.stringify({ _tag: "Request", id: 1, tag: "List", payload: { _tag: "flows" }, headers: [] }) + "\n" })
  assert.match(await unauthorized.text(), /Unauthorized|unauthorized/)
  const list = await rpc("List", { _tag: "flows" })
  assert.deepEqual(list.items.map(item => item.flowId).sort(), ["librarian/history", "librarian/wiki"])
  const wiki = await run("wiki")
  assert.equal(wiki.status, "completed", logs)
  assert.equal(published.sourceHead, sourceHead)
  assert.equal(published.pages.length, 2)
  assert.match(published.pages[1].body, /README.md/)
  // Production workspaces can have a detached source commit after provisioning.
  git(root, "checkout", "--detach", sourceHead)
  const history = await run("history")
  assert.equal(history.status, "completed", logs)
  assert.equal(git(root, "rev-parse", "mythical^{tree}"), git(root, "rev-parse", "main^{tree}"))
  assert.equal(git(root, "rev-parse", "HEAD"), sourceHead)
  assert.match(git(root, "notes", "--ref=mythical", "show", "mythical"), new RegExp(sourceHead))
  assert.equal((await run("wiki", "someone/else")).status, "failed")
  failPublication = true
  assert.equal((await run("wiki")).status, "failed", "unpublished Wiki must not report completion")
  await stop(); await start()
  assert.equal((await settled(wiki.runId)).status, "completed")
  assert.equal((await settled(history.runId)).status, "completed")
  assert.ok((await readFile(join(root, ".flows", "control.db"))).length > 0)
})
