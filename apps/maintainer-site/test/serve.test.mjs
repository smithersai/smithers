// The queue server: its API, the answers file (append-only, undo), live events and the file endpoint's refusals.
//
//   node --test apps/maintainer-site/test/serve.test.mjs
import assert from "node:assert/strict"
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, before, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { VERSION_FIELDS, coveragePercent, readAnswers, refusalFor, replay, startServer } from "../serve.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, "fixtures")
const HOUR = 60 * 60 * 1000

let base
let dir
let repo
let queueDir
let clock
let server

// A raw request, so tests can send any Host or Origin header.
function call(path, { method = "GET", headers = {}, body } = {}) {
  const { port } = new URL(base)
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8")
        let json = null
        try {
          json = JSON.parse(text)
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on("error", reject)
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body))
    req.end()
  })
}
// An answer names the version of the item Will opened, as the queue page does: here, the version queue.json holds now.
const seen = (itemId) => {
  const item = JSON.parse(readFileSync(join(queueDir, "queue.json"), "utf8")).items.find((candidate) => candidate.id === itemId)
  return Object.fromEntries(VERSION_FIELDS.map((field) => [field, item?.[field] ?? null]))
}
const answer = (body) => (body && typeof body === "object" && body.action !== "undo" ? { ...seen(body.itemId), ...body } : body)
const post = (body, headers = {}) => call("/api/answer", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: answer(body) })
const visibleIds = async () => (await call("/api/queue")).json.items.map((item) => item.id)
const answersText = () => readFileSync(join(queueDir, "answers.jsonl"), "utf8")

// Waits for the next `queue` event on an open SSE stream.
function events() {
  const { port } = new URL(base)
  let buffer = ""
  let waiters = []
  const req = request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: `localhost:${port}` } }, (res) => {
    res.setEncoding("utf8")
    res.on("data", (chunk) => {
      buffer += chunk
      if (buffer.includes("event: queue")) {
        buffer = ""
        for (const resolve of waiters) resolve()
        waiters = []
      }
    })
  })
  req.on("error", () => {})
  req.end()
  return {
    next: (ms = 3000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no queue event")), ms)
        waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      }),
    close: () => req.destroy(),
  }
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "queue-test-"))
  repo = join(dir, "repo")
  queueDir = join(dir, "queue")
  const site = join(dir, "site")
  const gifs = join(dir, "gifs")
  const videos = join(dir, "videos")
  const outside = join(dir, "outside")
  cpSync(join(fixtures, "repo"), repo, { recursive: true })
  mkdirSync(queueDir)
  mkdirSync(site)
  mkdirSync(gifs)
  mkdirSync(outside)
  mkdirSync(join(videos, "chat"), { recursive: true })
  copyFileSync(join(fixtures, "repo/videos/chat-shortcut.mp4"), join(videos, "chat/shortcut.mp4"))
  copyFileSync(join(fixtures, "repo/videos/chat-shortcut.mp4"), join(videos, "chat/auth-token-expires.mp4"))
  copyFileSync(join(fixtures, "repo/videos/chat-shortcut.chapters.json"), join(videos, "chat/auth-token-expires.chapters.json"))
  copyFileSync(join(fixtures, "queue.json"), join(queueDir, "queue.json"))
  copyFileSync(join(fixtures, "answers.jsonl"), join(queueDir, "answers.jsonl"))
  writeFileSync(join(site, "index.html"), "<!doctype html><title>Site</title>")
  copyFileSync(join(fixtures, "repo/gifs/flow.gif"), join(gifs, "walk.gif"))
  writeFileSync(join(outside, "secret.txt"), "outside the roots")
  // Things the file endpoint must never serve.
  writeFileSync(join(repo, ".env"), "KEY=1")
  writeFileSync(join(repo, ".env.local"), "KEY=1")
  writeFileSync(join(repo, ".dev.vars"), "KEY=1")
  mkdirSync(join(repo, ".git"))
  writeFileSync(join(repo, ".git/config"), "[core]")
  mkdirSync(join(repo, ".jj/repo"), { recursive: true })
  writeFileSync(join(repo, ".jj/repo/store"), "store")
  mkdirSync(join(repo, "node_modules/pkg"), { recursive: true })
  writeFileSync(join(repo, "node_modules/pkg/index.js"), "module.exports = 1")
  writeFileSync(join(repo, "secrets.json"), "{}")
  writeFileSync(join(repo, "id_rsa"), "key")
  writeFileSync(join(repo, "server.pem"), "key")
  mkdirSync(join(repo, "config"))
  writeFileSync(join(repo, "config/credentials.json"), "{}")
  writeFileSync(join(repo, "src/Secret.ts"), "export const Secret = 1\n")
  symlinkSync(join(outside, "secret.txt"), join(repo, "link-out.txt"))
  symlinkSync(outside, join(repo, "dir-out"))
  symlinkSync(join(repo, "src/shape-stream.ts"), join(repo, "link-in.ts"))
  symlinkSync(join(repo, ".env"), join(repo, "env-link.txt"))

  clock = { now: Date.parse("2026-10-20T15:00:00.000Z") }
  server = startServer({ port: 0, repo, gifs, videos, site, queueDir, now: () => clock.now, tickMs: 60_000 })
  base = await server.ready
})

after(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("GET /api/queue", () => {
  test("returns the items by priority, highest first, with their context rendered", async () => {
    const response = await call("/api/queue")
    assert.equal(response.status, 200)
    const priorities = response.json.items.map((item) => item.priority)
    assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a))
    assert.equal(response.json.items[0].id, "decision:electric-shapes")
    const decision = response.json.items[0]
    assert.match(decision.contextHtml, /<strong>shape<\/strong>/)
    assert.match(decision.contextHtml, /class="file"/)
  })

  test("a verify item carries the answer it verifies", async () => {
    const verify = (await call("/api/queue")).json.items.find((item) => item.id === "verify:shape-stream-limit")
    assert.equal(verify.verifies.itemId, "code:shape-stream@old")
    assert.match(verify.verifies.text, /^L12:/)
  })

  test("a missing queue.json is an empty queue, not an error", async () => {
    const empty = mkdtempSync(join(tmpdir(), "queue-empty-"))
    const other = startServer({ port: 0, repo, gifs: repo, site: repo, queueDir: empty })
    try {
      const url = await other.ready
      const response = await fetch(`${url.replace("localhost", "127.0.0.1")}/api/queue`, { headers: { host: new URL(url).host } })
      const body = await response.json()
      assert.equal(body.items.length, 0)
      assert.equal(body.missing, true)
    } finally {
      await other.close()
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe("POST /api/answer", () => {
  test("appends one fsynced line, keeps every earlier byte, and hides the item", async () => {
    const before = answersText()
    const response = await post({ itemId: "decision:electric-shapes", action: "option", option: "1", text: "Shapes, with a retry." })
    assert.equal(response.status, 200)
    const after = answersText()
    assert.ok(after.startsWith(before), "the file is appended to, never rewritten")
    const line = JSON.parse(after.slice(before.length))
    assert.deepEqual(Object.keys(line), ["itemId", "at", "action", "option", "text", "revision", "title"])
    assert.equal(line.at, new Date(clock.now).toISOString())
    assert.equal(line.title, "Read rows through Electric shapes, not polling")
    assert.equal(line.text, "Shapes, with a retry.")
    assert.ok(!(await visibleIds()).includes("decision:electric-shapes"))
  })

  test("undo is an appended record that returns the item to the queue", async () => {
    const before = answersText()
    const response = await post({ itemId: "decision:electric-shapes", action: "undo" })
    assert.equal(response.status, 200)
    const after = answersText()
    assert.ok(after.startsWith(before))
    assert.equal(JSON.parse(after.slice(before.length)).action, "undo")
    assert.ok((await visibleIds()).includes("decision:electric-shapes"))
  })

  test("a note that applies to all items of a kind records the scope and the item's kind; undo retracts it", async () => {
    const before = answersText()
    const response = await post({ itemId: "code:shape-stream@3f2a", action: "changes", scope: "all", kind: "design", text: "Show a diagram first." })
    assert.equal(response.status, 200)
    const line = JSON.parse(answersText().slice(before.length))
    assert.deepEqual(Object.keys(line), ["itemId", "at", "action", "scope", "kind", "text", "revision", "title"])
    assert.equal(line.scope, "all")
    assert.equal(line.kind, "code", "the kind comes from the item, not the client")
    assert.ok(!(await visibleIds()).includes("code:shape-stream@3f2a"))
    await post({ itemId: "code:shape-stream@3f2a", action: "undo" })
    assert.ok((await visibleIds()).includes("code:shape-stream@3f2a"))
    assert.equal((await post({ itemId: "code:shape-stream@3f2a", action: "approve", scope: "everything" })).status, 400)
  })

  test("undo with nothing to undo is refused and writes nothing", async () => {
    const before = answersText()
    const response = await post({ itemId: "design:status-pill@9124", action: "undo" })
    assert.equal(response.status, 409)
    assert.equal(answersText(), before)
  })

  test("two undos retract two answers, newest first", async () => {
    await post({ itemId: "design:status-pill@9124", action: "changes", text: "first" })
    clock.now += 1000
    await post({ itemId: "design:status-pill@9124", action: "approve", text: "second" })
    const { stacks } = replay(readAnswers(join(queueDir, "answers.jsonl")))
    assert.deepEqual(stacks.get("design:status-pill@9124").map((answer) => answer.text), ["first", "second"])
    await post({ itemId: "design:status-pill@9124", action: "undo" })
    assert.deepEqual(replay(readAnswers(join(queueDir, "answers.jsonl"))).stacks.get("design:status-pill@9124").map((answer) => answer.text), ["first"])
    assert.ok(!(await visibleIds()).includes("design:status-pill@9124"))
    await post({ itemId: "design:status-pill@9124", action: "undo" })
    assert.ok((await visibleIds()).includes("design:status-pill@9124"))
  })

  test("later hides an item for 24 hours", async () => {
    const start = clock.now
    await post({ itemId: "gif:chat-shortcut@bf47", action: "later" })
    assert.ok(!(await visibleIds()).includes("gif:chat-shortcut@bf47"))
    clock.now = start + 23 * HOUR
    assert.ok(!(await visibleIds()).includes("gif:chat-shortcut@bf47"))
    clock.now = start + 24 * HOUR + 1
    assert.ok((await visibleIds()).includes("gif:chat-shortcut@bf47"))
    clock.now = start
    await post({ itemId: "gif:chat-shortcut@bf47", action: "undo" })
  })

  test("an item the curator re-adds after the answer shows again", async () => {
    await post({ itemId: "verify:shape-stream-limit", action: "approve" })
    assert.ok(!(await visibleIds()).includes("verify:shape-stream-limit"))
    const queue = JSON.parse(readFileSync(join(queueDir, "queue.json"), "utf8"))
    queue.items.find((item) => item.id === "verify:shape-stream-limit").addedAt = new Date(clock.now + HOUR).toISOString()
    writeFileSync(join(queueDir, "queue.json.tmp"), JSON.stringify(queue))
    renameSync(join(queueDir, "queue.json.tmp"), join(queueDir, "queue.json"))
    assert.ok((await visibleIds()).includes("verify:shape-stream-limit"))
    copyFileSync(join(fixtures, "queue.json"), join(queueDir, "queue.json"))
    await post({ itemId: "verify:shape-stream-limit", action: "undo" })
  })

  test("an answer to a version the curator replaced is refused with the new version, and writes nothing", async () => {
    const opened = seen("code:shape-stream@3f2a")
    const replace = (change) => {
      const queue = JSON.parse(readFileSync(join(fixtures, "queue.json"), "utf8"))
      Object.assign(queue.items.find((item) => item.id === "code:shape-stream@3f2a"), { title: "Changed after review opened" }, change)
      writeFileSync(join(queueDir, "queue.json.tmp"), JSON.stringify(queue))
      renameSync(join(queueDir, "queue.json.tmp"), join(queueDir, "queue.json"))
    }
    try {
      for (const change of [{ revision: "new-digest" }, { commit: "0123456789abcdef" }, { addedAt: "2026-10-21T12:00:00Z" }]) {
        replace(change)
        const before = answersText()
        const response = await post({ itemId: "code:shape-stream@3f2a", action: "approve", ...opened })
        assert.equal(response.status, 409, JSON.stringify(change))
        assert.equal(response.json.item.title, "Changed after review opened")
        assert.equal(response.json.item[Object.keys(change)[0]], Object.values(change)[0])
        assert.equal(answersText(), before)
        assert.ok((await visibleIds()).includes("code:shape-stream@3f2a"), "nobody reviewed the new version")
      }
      replace({ revision: "new-digest" })
      const response = await post({ itemId: "code:shape-stream@3f2a", action: "approve", ...opened, revision: "new-digest" })
      assert.equal(response.status, 200)
      assert.equal(response.json.answer.revision, "new-digest")
      await post({ itemId: "code:shape-stream@3f2a", action: "undo" })
    } finally {
      copyFileSync(join(fixtures, "queue.json"), join(queueDir, "queue.json"))
    }
  })

  test("stats count today's answers and what remains by kind", async () => {
    const before = (await call("/api/stats")).json
    await post({ itemId: "question:scratch-repo", action: "option", option: "2" })
    const after = (await call("/api/stats")).json
    assert.equal(after.doneToday, before.doneToday + 1)
    assert.equal(after.remaining.question ?? 0, (before.remaining.question ?? 0) - 1)
    assert.equal(after.total, before.total - 1)
    await post({ itemId: "question:scratch-repo", action: "undo" })
    assert.equal((await call("/api/stats")).json.doneToday, before.doneToday)
  })

  test("coverage is the share of slice lines reviewed", () => {
    const slices = { a: { lines: 300, status: "reviewed" }, b: { lines: 100, status: "unreviewed" }, c: { lines: 600, status: "stale" } }
    assert.equal(coveragePercent({ slices }), 30)
    assert.equal(coveragePercent({ slices: {} }), null)
    assert.equal(coveragePercent({ percent: 12.34 }), 12.3)
    assert.equal(coveragePercent(null), null)
  })

  test("refuses bad input and writes nothing", async () => {
    const before = answersText()
    assert.equal((await post({ itemId: "x", action: "delete" })).status, 400)
    assert.equal((await post({ action: "approve" })).status, 400)
    assert.equal((await post({ itemId: "x", action: "option", option: "<script>" })).status, 400)
    assert.equal((await post({ itemId: "x", action: "approve", text: 42 })).status, 400)
    assert.equal((await post("{not json")).status, 400)
    assert.equal((await call("/api/answer", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415)
    assert.equal((await post({ itemId: "x", action: "approve", text: "x".repeat(300_000) })).status, 413)
    assert.equal(answersText(), before)
  })

  test("refuses another site's page and another host name", async () => {
    const before = answersText()
    assert.equal((await post({ itemId: "x", action: "approve" }, { origin: "https://evil.example" })).status, 403)
    assert.equal((await post({ itemId: "x", action: "approve" }, { origin: "null" })).status, 403)
    assert.equal((await call("/api/queue", { headers: { host: "evil.example" } })).status, 403)
    assert.equal(answersText(), before)
  })

  test("a torn last line is skipped and the next answer starts a fresh line", async () => {
    const file = join(queueDir, "answers.jsonl")
    writeFileSync(file, `${answersText()}{"itemId":"torn","act`, { flag: "w" })
    await post({ itemId: "code:shape-stream@3f2a", action: "approve" })
    const lines = answersText().trimEnd().split("\n")
    assert.equal(JSON.parse(lines.at(-1)).itemId, "code:shape-stream@3f2a")
    assert.ok(!readAnswers(file).some((answer) => answer.itemId === "torn"))
    await post({ itemId: "code:shape-stream@3f2a", action: "undo" })
  })
})

describe("GET /api/events", () => {
  test("sends a queue event when the curator renames a new queue.json into place", async () => {
    const stream = events()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const next = stream.next()
    writeFileSync(join(queueDir, "queue.json.tmp"), readFileSync(join(fixtures, "queue.json")))
    renameSync(join(queueDir, "queue.json.tmp"), join(queueDir, "queue.json"))
    await next
    stream.close()
  })

  test("tells a new page the client's version, so open pages reload between items after an update", async () => {
    const { port } = new URL(base)
    const text = await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: `localhost:${port}` } }, (res) => {
        res.setEncoding("utf8")
        res.once("data", (chunk) => {
          req.destroy()
          resolve(chunk)
        })
      })
      req.on("error", reject)
      req.end()
    })
    assert.match(text, /event: client\ndata: \{"version":"\d+(\.\d+)?"\}/)
  })

  test("sends a queue event when an answer is appended", async () => {
    const stream = events()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const next = stream.next()
    await post({ itemId: "gif:chat-shortcut@bf47", action: "approve" })
    await next
    stream.close()
    await post({ itemId: "gif:chat-shortcut@bf47", action: "undo" })
  })
})

describe("GET /api/file", () => {
  const file = (path) => call(`/api/file?path=${encodeURIComponent(path)}`)

  test("serves repository text as text", async () => {
    const response = await file("src/shape-stream.ts")
    assert.equal(response.status, 200)
    assert.match(response.headers["content-type"], /^text\/plain/)
    assert.match(response.text, /export class ShapeStream/)
  })

  test("serves images and GIFs with their type, from the repository and the GIF folder", async () => {
    assert.equal((await file("gifs/flow.gif")).headers["content-type"], "image/gif")
    const walk = await file(join(dirname(repo), "gifs/walk.gif"))
    assert.equal(walk.status, 200)
    assert.equal(walk.headers["content-type"], "image/gif")
  })

  test("serves HTML as HTML, sandboxed, and by path so its relative styles resolve", async () => {
    const page = await file("design/status.html")
    assert.match(page.headers["content-type"], /^text\/html/)
    assert.equal(page.headers["content-security-policy"], "sandbox allow-scripts")
    const byPath = await call("/api/file/design/status.html")
    assert.equal(byPath.status, 200)
    assert.equal((await call("/api/file/design/status.css")).headers["content-type"], "text/css; charset=utf-8")
  })

  test("serves recordings from the videos folder, with chapters, even when a test name says token", async () => {
    const video = await file(join(dirname(repo), "videos/chat/shortcut.mp4"))
    assert.equal(video.status, 200)
    assert.equal(video.headers["content-type"], "video/mp4")
    assert.equal(video.headers["accept-ranges"], "bytes")
    assert.equal((await file(join(dirname(repo), "videos/chat/auth-token-expires.mp4"))).status, 200)
    const chapters = await file(join(dirname(repo), "videos/chat/auth-token-expires.chapters.json"))
    assert.equal(chapters.status, 200)
    assert.equal(chapters.json[2].label, "Open chat")
  })

  test("answers byte ranges, so a video can seek", async () => {
    const path = `/api/file?path=${encodeURIComponent("videos/chat-shortcut.mp4")}`
    const whole = readFileSync(join(repo, "videos/chat-shortcut.mp4"))
    const size = whole.length
    const first = await call(path, { headers: { range: "bytes=0-9" } })
    assert.equal(first.status, 206)
    assert.equal(first.headers["content-range"], `bytes 0-9/${size}`)
    assert.equal(first.headers["content-length"], "10")
    const open = await call(path, { headers: { range: `bytes=${size - 5}-` } })
    assert.equal(open.status, 206)
    assert.equal(open.headers["content-range"], `bytes ${size - 5}-${size - 1}/${size}`)
    const suffix = await call(path, { headers: { range: "bytes=-4" } })
    assert.equal(suffix.headers["content-range"], `bytes ${size - 4}-${size - 1}/${size}`)
    assert.equal(suffix.headers["content-length"], "4")
    const past = await call(path, { headers: { range: `bytes=${size}-` } })
    assert.equal(past.status, 416)
    assert.equal(past.headers["content-range"], `bytes */${size}`)
    const clipped = await call(path, { headers: { range: `bytes=${size - 2}-${size + 100}` } })
    assert.equal(clipped.headers["content-length"], "2")
    const all = await call(path)
    assert.equal(all.status, 200)
    assert.equal(all.headers["content-length"], String(size))
  })

  test("a range of text is the exact bytes", async () => {
    const response = await call(`/api/file?path=${encodeURIComponent("src/shape-stream.ts")}`, { headers: { range: "bytes=3-8" } })
    assert.equal(response.status, 206)
    assert.equal(response.text, readFileSync(join(repo, "src/shape-stream.ts"), "utf8").slice(3, 9))
  })

  test("HEAD answers the headers without the body", async () => {
    const response = await call(`/api/file?path=${encodeURIComponent("videos/chat-shortcut.mp4")}`, { method: "HEAD" })
    assert.equal(response.status, 200)
    assert.equal(response.text, "")
    assert.equal(response.headers["content-type"], "video/mp4")
  })

  test("serves queue/before, where the curator keeps old recordings, with the same refusals", async () => {
    const folder = join(queueDir, "before/verify-x")
    mkdirSync(folder, { recursive: true })
    copyFileSync(join(fixtures, "repo/videos/chat-shortcut.mp4"), join(folder, "old.mp4"))
    writeFileSync(join(folder, ".env"), "KEY=1")
    symlinkSync(join(dirname(repo), "outside/secret.txt"), join(folder, "out.txt"))
    const video = await file(join(folder, "old.mp4"))
    assert.equal(video.status, 200)
    assert.equal(video.headers["content-type"], "video/mp4")
    assert.equal((await file(join(folder, ".env"))).status, 403)
    assert.equal((await file(join(folder, "out.txt"))).status, 403)
    assert.equal((await file(join(queueDir, "before/../answers.jsonl"))).status, 403)
  })

  test("follows a symlink that stays inside the roots", async () => {
    assert.equal((await file("link-in.ts")).status, 200)
  })

  test("serves source code whose name mentions a secret", async () => {
    assert.equal((await file("src/Secret.ts")).status, 200)
  })

  for (const [path, why] of [
    ["../outside/secret.txt", "traversal"],
    ["src/../../outside/secret.txt", "traversal through a folder"],
    ["/etc/hosts", "an absolute path outside the roots"],
    ["link-out.txt", "a symlink out of the roots"],
    ["dir-out/secret.txt", "a symlinked folder out of the roots"],
    ["env-link.txt", "a symlink to .env"],
    [".env", ".env"],
    [".env.local", ".env.local"],
    [".dev.vars", ".dev.vars"],
    [".git/config", ".git"],
    [".jj/repo/store", ".jj"],
    ["node_modules/pkg/index.js", "node_modules"],
    ["secrets.json", "a secret name"],
    ["id_rsa", "an SSH key"],
    ["server.pem", "a PEM file"],
    ["config/credentials.json", "credentials"],
  ])
    test(`refuses ${why}: ${path}`, async () => {
      const response = await file(path)
      assert.equal(response.status, 403, `${path} gave ${response.status}`)
      assert.doesNotMatch(response.text, /outside the roots$|KEY=1|\[core\]|store|module\.exports/)
    })

  test("refuses the path form of a traversal", async () => {
    assert.notEqual((await call("/api/file/..%2Foutside%2Fsecret.txt")).status, 200)
    assert.notEqual((await call("/api/file/%2E%2E/outside/secret.txt")).status, 200)
  })

  test("answers 404 for a missing file or a folder, 400 for no path", async () => {
    assert.equal((await file("src/nope.ts")).status, 404)
    assert.equal((await file("src")).status, 404)
    assert.equal((await call("/api/file")).status, 400)
  })

  test("refusalFor names the forbidden segment", () => {
    assert.equal(refusalFor(["a", ".git", "config"]), "refused: .git")
    assert.equal(refusalFor(["packages", "secrets", "src", "Secret.ts"]), null)
    assert.equal(refusalFor(["deploy", "prod.tfvars"]), "refused: secret name")
    assert.equal(refusalFor(["apps", "tokens.json"]), "refused: secret name")
    assert.equal(refusalFor(["chat", "auth-token.mp4"]), null)
    assert.equal(refusalFor(["chat", "auth-token.chapters.json"]), null)
    assert.equal(refusalFor(["secrets", "id_rsa.mp4"]), null)
  })
})

describe("GET /api/markdown", () => {
  const doc = (path) => call(`/api/markdown?path=${encodeURIComponent(path)}`)

  test("renders a README: headings, code, tables, lists, and links and images resolved beside the file", async () => {
    const response = await doc("docs/README.md")
    assert.equal(response.status, 200)
    const { html, title } = response.json
    assert.equal(title, "ShapeStream")
    assert.match(html, /<h2 id="install">Install<\/h2>/)
    assert.match(html, /<pre data-lang="ts"><code class="language-ts">/)
    assert.match(html, /<th>Option<\/th>/)
    assert.match(html, /<li>Rows arrive in order\.<\/li>/)
    assert.match(html, /href="\/api\/file\?path=src%2Fshape-stream\.ts"/, "a relative link resolves beside the file")
    assert.match(html, /src="\/api\/file\?path=design%2Fstatus\.svg"/, "an image resolves beside the file")
    assert.match(html, /href="https:\/\/electric-sql\.com\/docs"/)
    assert.match(html, /href="#install"/)
    assert.match(html, /class="callout callout-note"/)
  })

  test("never passes raw script through", async () => {
    const { html } = (await doc("docs/README.md")).json
    assert.doesNotMatch(html, /<script/i)
  })

  test("keeps the file endpoint's refusals", async () => {
    writeFileSync(join(repo, ".env.md"), "# KEY=1")
    assert.equal((await doc(".env.md")).status, 403)
    assert.equal((await doc("../outside/secret.txt")).status, 403)
    assert.equal((await doc("node_modules/pkg/index.js")).status, 403)
    assert.equal((await doc("docs/missing.md")).status, 404)
  })
})

describe("GET /api/outline", () => {
  const outline = (path) => call(`/api/outline?path=${encodeURIComponent(path)}`)

  test("parses a TypeScript file: comment lines, folds and symbols", async () => {
    const response = await outline("src/shape-stream.ts")
    assert.equal(response.status, 200)
    const { supported, comments, folds, symbols } = response.json
    assert.equal(supported, true)
    assert.deepEqual(comments.lines, [[1, 1], [4, 4], [18, 18], [44, 44]])
    assert.ok(folds.some((fold) => fold.from === 13 && fold.to === 28 && fold.kind === "class"))
    assert.deepEqual(symbols.find((symbol) => symbol.name === "ShapeStream"), { name: "ShapeStream", kind: "class", line: 13, depth: 0, exported: true })
  })

  test("answers again after the file changes, from a fresh parse", async () => {
    writeFileSync(join(repo, "src/changing.ts"), "export const a = 1\n")
    assert.deepEqual((await outline("src/changing.ts")).json.symbols.map((symbol) => symbol.name), ["a"])
    writeFileSync(join(repo, "src/changing.ts"), "// now longer\nexport const a = 1\nexport const b = 2\n")
    const again = (await outline("src/changing.ts")).json
    assert.deepEqual(again.symbols.map((symbol) => symbol.name), ["a", "b"])
    assert.deepEqual(again.comments.lines, [[1, 1]])
  })

  test("says a file it cannot parse is unsupported", async () => {
    const response = await outline("src/shape-stream.css")
    assert.equal(response.status, 200)
    assert.deepEqual(response.json, { supported: false })
  })

  test("keeps the file endpoint's refusals", async () => {
    assert.equal((await outline(".env")).status, 403)
    assert.equal((await outline("node_modules/pkg/index.js")).status, 403)
    assert.equal((await outline("../outside/secret.txt")).status, 403)
    assert.equal((await outline("src/missing.ts")).status, 404)
    assert.equal((await call("/api/outline")).status, 400)
  })
})

describe("pages", () => {
  test("serves the queue client and the built site", async () => {
    const queue = await call("/queue")
    assert.equal(queue.status, 200)
    assert.match(queue.text, /queue\.js/)
    assert.match((await call("/queue/queue.css")).headers["content-type"], /^text\/css/)
    assert.equal((await call("/queue/serve.mjs")).status, 404)
    assert.match((await call("/")).text, /<title>Site<\/title>/)
    assert.notEqual((await call("/../repo/.env")).status, 200)
  })
})
