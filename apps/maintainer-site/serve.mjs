#!/usr/bin/env node
// Serves the maintainer site and Will's decision queue on 127.0.0.1.
//
//   node apps/maintainer-site/serve.mjs        # http://localhost:4747/queue
//
// No dependencies. The curator writes queue/queue.json (atomic rename) and queue/coverage.json; this server only
// appends to queue/answers.jsonl, one fsynced line per answer, and never rewrites it.
//
// Environment: PORT (4747), QUEUE_DIR (./queue), MAINTAINER_SITE_REPO (the repository root),
// MAINTAINER_SITE_GIFS (~/Desktop/smithers-mvp/gifs), MAINTAINER_SITE_VIDEOS (~/Desktop/smithers-mvp/videos),
// MAINTAINER_SITE_OUT (~/Desktop/smithers-maintainer).
import { closeSync, createReadStream, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, watch, writeSync } from "node:fs"
import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { renderMarkdown, safeUrl } from "./markdown.mjs"
import { OUTLINE_EXT, outlineOf } from "./outline.mjs"

const here = dirname(fileURLToPath(import.meta.url))

export const ACTIONS = ["option", "approve", "changes", "later", "undo"]
export const SNOOZE_MS = 24 * 60 * 60 * 1000
const DONE_ACTIONS = new Set(["option", "approve", "changes"])
const MAX_BODY = 256 * 1024
// The fields that name one version of a queued item. An answer names the version Will saw.
export const VERSION_FIELDS = ["revision", "commit", "addedAt"]
const MAX_FILE = 64 * 1024 * 1024

// ---------------------------------------------------------------------------------------------------------
// Files: read-only, inside the allowed roots, never secrets.

import { resolveFile, refusalFor } from "./checked-file.mjs"
export { resolveFile, refusalFor }
const TYPES = {
  ".gif": "image/gif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
}
const isBinary = (buffer) => buffer.subarray(0, 8192).includes(0)

// ---------------------------------------------------------------------------------------------------------
// The queue: queue.json as the curator wrote it, minus what answers.jsonl hides.

export function readAnswers(file) {
  if (!existsSync(file)) return []
  const answers = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      const answer = JSON.parse(line)
      if (answer && typeof answer.itemId === "string" && ACTIONS.includes(answer.action)) {
        // Existing append-only journals predate receipts. The ordinal distinguishes even identical lines.
        answer.answerId ??= `legacy-${hash(JSON.stringify([answers.length, line]))}`
        answers.push(answer)
      }
    } catch {
      // A torn last line from a crash is skipped; the next append starts on a fresh line.
    }
  }
  return answers
}

// Replays answers in order. Each item keeps a stack; `undo` pops the latest answer to it.
export function replay(answers) {
  const stacks = new Map()
  for (const answer of answers) {
    const stack = stacks.get(answer.itemId) ?? []
    if (answer.action === "undo") {
      if (!answer.undoes || stack.at(-1)?.answerId === answer.undoes) stack.pop()
    } else stack.push(answer)
    stacks.set(answer.itemId, stack)
  }
  // `last` is the newest answer still standing, whichever item it belongs to: what `u` undoes next.
  let last = null
  for (const stack of stacks.values()) for (const answer of stack) if (!last || answer.at >= last.at) last = answer
  return { stacks, last }
}

// An answered item stays hidden until the curator re-adds it (a newer addedAt); `later` hides it for 24 hours.
export function isHidden(item, stacks, now) {
  const top = stacks.get(item.id)?.at(-1)
  if (!top || (top.digest && top.digest !== item.digest)) return false
  const at = Date.parse(top.at)
  // Explicit generations survive clock skew; historical records use their save time.
  if (item.addedAt && (top.addedAt ? item.addedAt !== top.addedAt : Date.parse(item.addedAt) > at)) return false
  if (top.action === "later") return now - at < SNOOZE_MS
  return true
}

// The share of code lines Will has reviewed, from the curator's coverage.json: `{ slices: { id: { lines, status } } }`,
// or a precomputed `percent`.
export function coveragePercent(data) {
  let percent = data?.percent ?? null
  if (percent == null && data?.slices && typeof data.slices === "object") {
    let total = 0
    let reviewed = 0
    for (const slice of Object.values(data.slices)) {
      const lines = Number(slice?.lines) || 0
      total += lines
      if (slice?.status === "reviewed" || slice?.status === "approved") reviewed += lines
    }
    percent = total ? (100 * reviewed) / total : null
  }
  return typeof percent === "number" && Number.isFinite(percent) ? Math.round(percent * 10) / 10 : null
}

// The code view's comments, folds and symbols come from TypeScript's parser, loaded on the first outline asked for so
// the server starts without it. It resolves from the workspace root, where `typescript` is a dependency.
let typescript = null
const loadTypeScript = () => (typescript ??= import("typescript").then((module) => module.default ?? module))
const OUTLINE_CACHE = 64

const hash = (value) => createHash("sha256").update(value).digest("hex")
const assetPolicy = { "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'", "X-Content-Type-Options": "nosniff" }
const assetType = (file) => {
  const ext = extname(file).toLowerCase()
  if ([".html", ".htm", ".css", ".js", ".mjs", ".svg", ".json", ".gif", ".png", ".jpg", ".jpeg", ".avif", ".webp", ".mp4", ".webm", ".mov", ".m4v"].includes(ext)) return TYPES[ext]
  return "text/plain; charset=utf-8"
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

export function startServer(options = {}) {
  const port = options.port ?? Number(process.env.PORT ?? 4747)
  const writeToken = options.writeToken ?? process.env.MAINTAINER_WRITE_TOKEN
  const authorized = (request) => {
    const header = request.headers.authorization ?? ""
    const expected = "Basic " + Buffer.from("maintainer:" + writeToken).toString("base64")
    return Boolean(writeToken) && [expected, "Bearer " + writeToken].some((value) => timingSafeEqual(Buffer.from(hash(header)), Buffer.from(hash(value))))
  }
  const host = "127.0.0.1"
  const repo = resolve(options.repo ?? process.env.MAINTAINER_SITE_REPO ?? resolve(here, "../.."))
  const gifs = resolve(options.gifs ?? process.env.MAINTAINER_SITE_GIFS ?? join(homedir(), "Desktop/smithers-mvp/gifs"))
  const videos = resolve(options.videos ?? process.env.MAINTAINER_SITE_VIDEOS ?? join(homedir(), "Desktop/smithers-mvp/videos"))
  const site = resolve(options.site ?? process.env.MAINTAINER_SITE_OUT ?? join(homedir(), "Desktop/smithers-maintainer"))
  const queueDir = resolve(options.queueDir ?? process.env.QUEUE_DIR ?? join(here, "queue"))
  const clientDir = join(here, "client")
  const now = options.now ?? (() => Date.now())
  const queueFile = join(queueDir, "queue.json")
  const answersFile = join(queueDir, "answers.jsonl")
  const coverageFile = join(queueDir, "coverage.json")
  const readCoverageFile = options.readCoverageFile ?? readFileSync
  const readCoverage = () => {
    try { return JSON.parse(readCoverageFile(coverageFile, "utf8")) } catch { return null }
  }
  mkdirSync(queueDir, { recursive: true })

  // A root's real path is resolved on each use, so a folder created after start (queue/before) still matches.
  const rootOf = (path) => ({
    path,
    get real() {
      try {
        return realpathSync(path)
      } catch {
        return path
      }
    },
  })
  // queue/before/<id>/ holds the old recordings and files a verify item compares against; the curator copies them in.
  const roots = [rootOf(repo), rootOf(gifs), rootOf(videos), rootOf(join(queueDir, "before"))]

  // queue.json, cached by file identity, change time, mtime and size; a parse failure keeps the last good copy.
  let cached = { key: "", queue: { version: 1, generatedAt: null, items: [] }, error: null }
  const readQueue = () => {
    let stat
    try {
      stat = statSync(queueFile)
    } catch {
      return { version: 1, generatedAt: null, items: [], missing: true }
    }
    const key = `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`
    if (key === cached.key) return cached.queue
    try {
      const parsed = JSON.parse(readFileSync(queueFile, "utf8"))
      const items = (Array.isArray(parsed.items) ? parsed.items : []).filter((item) => item && typeof item.id === "string")
      for (const item of items) item.contextHtml = renderContext(item.context)
      items.sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0))
      cached = { key, queue: { version: parsed.version ?? 1, generatedAt: parsed.generatedAt ?? null, items }, error: null }
    } catch (error) {
      cached = { ...cached, key, error: String(error.message ?? error) }
    }
    return cached.queue
  }

  // A slice owns its commit; callers cannot request arbitrary repository history.
  const commitFiles = new Map()
  const recordedFile = (url, path = url.searchParams.get("path")) => {
    const id = url.searchParams.get("slice")
    if (!id) return null
    const item = readQueue().items.find((item) => item.id === id)
    const coverage = readCoverage()?.slices?.[id]
    const commit = item?.commit || coverage?.commit
    if (url.searchParams.has("expectedCommit") && (!item || commit !== url.searchParams.get("expectedCommit"))) return { status: 409, error: "review changed" }
    if (!commit) return null
    const entries = item?.files ?? coverage?.files ?? []
    if (typeof path !== "string" || !entries.some((file) => (typeof file === "string" ? file.replace(/:\d+(?:-\d+)?$/, "") : file.path) === path))
      return { status: 403, error: "file is not in this slice" }
    if (isAbsolute(path) || path.split(/[\\/]/).some((part) => part === ".." || part === ".") || path.includes("\0"))
      return { status: 403, error: "refused path" }
    const refusal = refusalFor(path.split("/"))
    if (refusal) return { status: 403, error: refusal }
    const key = JSON.stringify([commit, path])
    if (commitFiles.has(key)) return { path, body: commitFiles.get(key) }
    try {
      const body = execFileSync("jj", ["--ignore-working-copy", "file", "show", "-r", String(commit), "--", path], { cwd: repo, maxBuffer: MAX_FILE, stdio: ["ignore", "pipe", "pipe"] })
      commitFiles.set(key, body)
      if (commitFiles.size > 32) commitFiles.delete(commitFiles.keys().next().value)
      return { path, body }
    } catch { return { status: 404, error: "recorded file unavailable" } }
  }

  const state = () => {
    const queue = readQueue()
    const answers = readAnswers(answersFile)
    const { stacks, last } = replay(answers)
    const at = now()
    const coverage = readCoverage()
    const reviewed = queue.items.map((item) => reviewedItem(item, answers, coverage?.slices))
    const visible = reviewed.filter((item) => !isHidden(item, stacks, at))
    return { queue: { ...queue, items: reviewed }, answers, stacks, last, visible, at, coverage }
  }

  // Outlines by real path and the checked descriptor's identity and change times.
  const outlines = new Map()
  const outline = async ({ real, fd, stat }) => {
    if (!OUTLINE_EXT.has(extname(real).toLowerCase())) return { supported: false }
    const key = `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`
    const held = outlines.get(real)
    if (held?.key === key) return held.outline
    const ts = await loadTypeScript()
    const result = { supported: true, ...outlineOf(ts, readFileSync(fd, "utf8"), real) }
    outlines.delete(real)
    outlines.set(real, { key, outline: result })
    if (outlines.size > OUTLINE_CACHE) outlines.delete(outlines.keys().next().value)
    return result
  }

  const verifies = (ref, answers) => {
    if (!ref) return null
    const hit = answers.findLast((answer) => answer.action !== "undo" && (`${answer.itemId}@${answer.at}` === ref || answer.at === ref || answer.itemId === ref))
    return hit ? { itemId: hit.itemId, title: hit.title ?? "", action: hit.action, option: hit.option ?? null, text: hit.text ?? "", at: hit.at } : null
  }

  const stats = () => {
    const { queue, stacks, visible, at, coverage } = state()
    const today = new Date(at)
    let doneToday = 0
    for (const stack of stacks.values()) for (const answer of stack) if (DONE_ACTIONS.has(answer.action) && sameDay(new Date(answer.at), today)) doneToday++
    const remaining = {}
    for (const item of visible) remaining[item.kind] = (remaining[item.kind] ?? 0) + 1
    return { doneToday, remaining, total: visible.length, all: queue.items.length, coverage: coveragePercent(coverage) }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Server-sent events: one `queue` event per burst of changes to the queue folder or a new answer.

  const listeners = new Set()
  let pending = null
  let signature = ""
  const emit = () => {
    clearTimeout(pending)
    pending = setTimeout(() => {
      try {
        signature = state().visible.map((item) => item.id).join("\n")
      } catch {}
      const payload = `event: queue\ndata: ${JSON.stringify({ at: new Date(now()).toISOString() })}\n\n`
      for (const response of listeners) response.write(payload)
    }, 40)
  }
  const watcher = watch(queueDir, (_event, name) => {
    if (!name || ["queue.json", "answers.jsonl", "coverage.json"].includes(String(name))) emit()
  })
  watcher.on("error", () => {})
  // A new client build: open pages pick it up between items.
  const clientVersion = () => {
    let version = 0
    for (const name of ["queue.html", "queue.js", "queue.css"])
      try {
        version = Math.max(version, statSync(join(clientDir, name)).mtimeMs)
      } catch {}
    return String(version)
  }
  let clientTimer = null
  const clientWatcher = watch(clientDir, () => {
    clearTimeout(clientTimer)
    clientTimer = setTimeout(() => {
      const payload = `event: client\ndata: ${JSON.stringify({ version: clientVersion() })}\n\n`
      for (const response of listeners) response.write(payload)
    }, 100)
  })
  clientWatcher.on("error", () => {})
  // A snooze that expires changes the queue without touching a file.
  const ticker = setInterval(() => {
    try {
      const next = state().visible.map((item) => item.id).join("\n")
      if (next !== signature) emit()
    } catch {}
  }, options.tickMs ?? 30_000)
  const keepAlive = setInterval(() => {
    for (const response of listeners) response.write(": keep-alive\n\n")
  }, 25_000)

  // ---------------------------------------------------------------------------------------------------------
  // HTTP.

  const allowedHosts = () => {
    const actual = server.address()?.port ?? port
    return new Set([`127.0.0.1:${actual}`, `localhost:${actual}`, `[::1]:${actual}`])
  }
  const send = (response, status, body, type = "application/json; charset=utf-8", headers = {}) => {
    const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers })
    response.end(data)
  }
  const sendFile = (response, file, extraHeaders = {}) => {
    const ext = extname(file).toLowerCase()
    const body = readFileSync(file)
    const type = TYPES[ext] ?? (isBinary(body) ? "application/octet-stream" : "text/plain; charset=utf-8")
    send(response, 200, body, type, extraHeaders)
  }
  // A file from the allowed roots, streamed, with byte ranges so a video can seek.
  const sendRange = (request, response, { real, fd, size, bytes }, extraHeaders) => {
    let streaming = false
    try {
      const ext = extname(real).toLowerCase()
      let type = extraHeaders?.["Content-Type"] ?? TYPES[ext]
      if (!type) {
        const head = Buffer.alloc(Math.min(size, 8192))
        readSync(fd, head, 0, head.length, 0)
        type = isBinary(head) ? "application/octet-stream" : "text/plain; charset=utf-8"
      }
      const headers = { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Accept-Ranges": "bytes", ...extraHeaders }
      let start = 0
      let end = size - 1
      let status = 200
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? "").trim())
      if (range && (range[1] !== "" || range[2] !== "")) {
        if (range[1] === "") {
          // A suffix: the last N bytes.
          start = Math.max(0, size - Number(range[2]))
        } else {
          start = Number(range[1])
          if (range[2] !== "") end = Math.min(end, Number(range[2]))
        }
        if (start >= size || start > end) {
          response.writeHead(416, { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": 0 })
          return response.end()
        }
        status = 206
        headers["Content-Range"] = `bytes ${start}-${end}/${size}`
      }
      headers["Content-Length"] = size === 0 ? 0 : end - start + 1
      response.writeHead(status, headers)
      if (request.method === "HEAD" || size === 0) return response.end()
      if (bytes) return response.end(bytes.subarray(start, end + 1))
      const stream = createReadStream(null, { fd, start, end })
      streaming = true
      stream.on("error", () => response.destroy())
      response.on("close", () => stream.destroy())
      stream.pipe(response)
    } finally {
      // A stream owns and closes its descriptor. All responses without one close it here.
      if (!streaming && fd !== undefined) closeSync(fd)
    }
  }
  const staticUnder = (response, base, path) => {
    const target = resolve(base, `.${path}`)
    if (target !== base && !target.startsWith(base + sep)) return send(response, 403, { error: "refused" })
    let real
    try {
      real = realpathSync(target)
      if (statSync(real).isDirectory()) real = realpathSync(join(real, "index.html"))
    } catch {
      return send(response, 404, { error: "not found" })
    }
    const root = rootOf(base)
    const found = resolveFile(real, [root])
    if (found.error) return send(response, found.status, { error: found.error })
    try {
      const name = relative(root.real, found.real)
      const trusted = ["index.html", "assets/site.js", "assets/data.js", "assets/site.css"].includes(name)
        && relative(base, target) === name
      const body = readFileSync(found.fd)
      return trusted ? send(response, 200, body, TYPES[extname(name)]) : send(response, 200, body, assetType(name), assetPolicy)
    } finally { closeSync(found.fd) }
  }

  const readBody = (request) =>
    new Promise((resolveBody, reject) => {
      const chunks = []
      let size = 0
      // An oversized body is read to its end and dropped, so the client still gets its 413.
      request.on("data", (chunk) => {
        size += chunk.length
        if (size <= MAX_BODY) chunks.push(chunk)
      })
      request.on("end", () => (size > MAX_BODY ? reject(Object.assign(new Error("body too large"), { status: 413 })) : resolveBody(Buffer.concat(chunks).toString("utf8"))))
      request.on("error", reject)
    })

  const append = (record) => {
    const fd = openSync(answersFile, "a")
    try {
      // Start on a fresh line if the file ends in a torn write.
      let prefix = ""
      try {
        const size = statSync(answersFile).size
        if (size > 0) {
          const last = Buffer.alloc(1)
          const reader = openSync(answersFile, "r")
          try {
            if (readSync(reader, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) prefix = "\n"
          } finally {
            closeSync(reader)
          }
        }
      } catch {}
      writeSync(fd, `${prefix}${JSON.stringify(record)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  // An item as the page receives it: a verify item carries the answer it verifies.
  const withAnswer = (item, answers) => (item.kind === "verify" ? { ...item, verifies: verifies(item.answerRef, answers) } : item)

  const fingerprints = new Map()
  function reviewedItem(raw, answers, slices) {
    const item = { ...withAnswer(raw, answers) }
    if (!item.commit && item.files?.length && slices?.[item.id]?.commit) item.commit = slices[item.id].commit
    const assets = Object.create(null)
    const capture = (path) => {
      if (typeof path !== "string" || Object.hasOwn(assets, path)) return
      const found = resolveFile(path, roots)
      if (found.error) { assets[path] = null; return }
      try {
        const { dev, ino, size, ctimeNs } = fstatSync(found.fd, { bigint: true })
        const key = [dev, ino, size, ctimeNs].join(":")
        let digest = fingerprints.get(key)
        if (!digest) {
          digest = hash(readFileSync(found.fd))
          if (fingerprints.size >= 2048) fingerprints.delete(fingerprints.keys().next().value)
          fingerprints.set(key, digest)
        }
        assets[path] = digest
      } finally { closeSync(found.fd) }
    }
    if (!item.commit) for (const file of item.files ?? []) capture(typeof file === "string" ? file.replace(/:\d+(?:-\d+)?$/, "") : file.path)
    function captureMedia(value) {
      if (Array.isArray(value)) return value.forEach(captureMedia)
      if (!value || typeof value !== "object") return
      capture(value.path)
      capture(value.chapters)
      captureMedia(value.media)
    }
    for (const value of [item.media, item.before, item.after, item.links]) captureMedia(value)
    return { ...item, assets, digest: hash(JSON.stringify([item, assets])) }
  }

  const answer = async (request, response) => {
    if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) return send(response, 415, { error: "send application/json" })
    let input
    try {
      input = JSON.parse(await readBody(request))
    } catch (error) {
      return send(response, error.status ?? 400, { error: error.status ? error.message : "invalid JSON" })
    }
    if (!input || typeof input !== "object") return send(response, 400, { error: "an Answer object is required" })
    const { itemId, action } = input
    if (typeof itemId !== "string" || itemId === "" || itemId.length > 512) return send(response, 400, { error: "itemId required" })
    if (!ACTIONS.includes(action)) return send(response, 400, { error: `action must be one of ${ACTIONS.join(", ")}` })
    const text = input.text ?? ""
    if (typeof text !== "string" || text.length > 50_000) return send(response, 400, { error: "text must be a string under 50,000 characters" })
    if (action === "option" && (typeof input.option !== "string" || !/^[1-9]$/.test(input.option))) return send(response, 400, { error: "option must be 1-9" })
    // "all": Will's note applies to every item of this kind (zoom, a missing timeline), not only this one.
    if (input.scope !== undefined && input.scope !== "all") return send(response, 400, { error: 'scope must be "all"' })
    const current = state()
    const item = current.queue.items.find((candidate) => candidate.id === itemId)
    if (action === "undo" && !current.stacks.get(itemId)?.length) return send(response, 409, { error: "nothing to undo" })
    const undone = action === "undo" ? current.stacks.get(itemId).at(-1) : null
    if (undone && input.answerId !== undone.answerId) return send(response, 409, { error: "answer changed since you selected it" })
    // The curator replaced the item after Will opened it: refuse, and send the version now queued.
    if (action !== "undo" && (!item || cached.error)) return send(response, 409, { error: "item unavailable" })
    // The check and fsynced append run without yielding: another tab or a retry cannot add a second answer.
    if (action !== "undo" && isHidden(item ?? { id: itemId }, current.stacks, current.at))
      return send(response, 409, { error: "already answered" })
    if (item && action !== "undo" && (input.digest !== item.digest || VERSION_FIELDS.some((field) => (input[field] ?? null) !== (item[field] ?? null))))
      return send(response, 409, { error: "changed since you opened it", item })
    const record = {
      itemId,
      answerId: randomUUID(),
      ...(undone ? { undoes: undone.answerId } : {}),
      at: new Date(now()).toISOString(),
      action,
      ...(action === "option" ? { option: input.option } : {}),
      ...(input.scope === "all" && action !== "undo" ? { scope: "all", kind: item?.kind ?? (typeof input.kind === "string" ? input.kind.slice(0, 40) : null) } : {}),
      text,
      digest: undone?.digest ?? item?.digest,
      commit: undone?.commit ?? item?.commit ?? null,
      revision: item?.revision ?? (typeof input.revision === "string" ? input.revision : undone?.revision ?? null),
      ...(item?.addedAt ? { addedAt: item.addedAt } : {}),
      title: item?.title ?? (typeof input.title === "string" ? input.title.slice(0, 200) : undone?.title ?? ""),
    }
    append(record)
    emit()
    return send(response, 200, { ok: true, answer: record })
  }

  const handle = async (request, response) => {
    if (!allowedHosts().has(String(request.headers.host ?? "").toLowerCase())) return send(response, 403, { error: "refused: host" })
    const url = new URL(request.url, `http://${request.headers.host}`)
    let path = url.pathname
    if (path.startsWith("/api/file/")) {
      try { url.searchParams.set("path", decodeURIComponent(path.slice("/api/file/".length))) }
      catch { return send(response, 400, { error: "bad path" }) }
      path = "/api/file"
    }
    if (request.method === "POST") {
      const origin = request.headers.origin
      if (origin !== undefined && origin !== url.origin) return send(response, 403, { error: "refused: origin" })
      if (path === "/api/answer") {
        if (request.headers["x-maintainer-write"] !== "1") return send(response, 403, { error: "maintainer credentials required" })
        if (!authorized(request)) {
          if (writeToken) return send(response, 401, { error: "maintainer credentials required" }, "application/json; charset=utf-8", { "WWW-Authenticate": 'Basic realm="Maintainer queue"' })
          return send(response, 403, { error: "maintainer credentials required" })
        }
        return answer(request, response)
      }
      return send(response, 404, { error: "not found" })
    }
    if (request.method !== "GET" && request.method !== "HEAD") return send(response, 405, { error: "method not allowed" })

    if (path === "/api/queue") {
      const { queue, visible, last } = state()
      const items = visible
      return send(response, 200, { version: queue.version, generatedAt: queue.generatedAt, missing: Boolean(queue.missing), error: cached.error, items, last: last ? { itemId: last.itemId, answerId: last.answerId, title: last.title ?? "", action: last.action, at: last.at } : null })
    }
    if (path === "/api/stats") return send(response, 200, stats())
    if (path === "/api/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" })
      response.write(`retry: 1000\n\nevent: client\ndata: ${JSON.stringify({ version: clientVersion() })}\n\n`)
      listeners.add(response)
      request.on("close", () => listeners.delete(response))
      return
    }
    if (url.searchParams.has("digest") && ["/api/file", "/api/outline", "/api/markdown"].includes(path)) {
      const id = url.searchParams.get("slice")
      const raw = readQueue().items.find((entry) => entry.id === id)
      const item = raw && reviewedItem(raw, readAnswers(answersFile), readCoverage()?.slices)
      if (!item || cached.error || item.digest !== url.searchParams.get("digest")) return send(response, 409, { error: "review changed" })
      const requested = url.searchParams.get("path")
      const recordedCode = item.commit && item.files?.some((file) => (typeof file === "string" ? file.replace(/:\d+(?:-\d+)?$/, "") : file.path) === requested)
      if (!recordedCode && Object.hasOwn(item.assets, requested)) {
        const found = resolveFile(requested, roots)
        if (found.error) return send(response, found.status, { error: found.error })
        let bytes
        try { bytes = readFileSync(found.fd) } finally { closeSync(found.fd) }
        if (hash(bytes) !== item.assets[requested]) return send(response, 409, { error: "asset changed" })
        if (path === "/api/outline") return send(response, 200, OUTLINE_EXT.has(extname(requested).toLowerCase())
          ? { supported: true, ...outlineOf(await loadTypeScript(), bytes.toString("utf8"), requested) } : { supported: false })
        if (path === "/api/markdown") return send(response, 200, renderDocument(found.real, roots[0].real, bytes))
        return sendRange(request, response, { real: found.real, bytes, size: bytes.length }, { ...assetPolicy, "Content-Type": assetType(found.real) })
      }
      if (!item.commit || (!recordedCode && path === "/api/markdown")) return send(response, 403, { error: "file outside review" })
      if (!/^[a-f0-9]{40,64}$/i.test(item.commit)) return send(response, 409, { error: "immutable commit required" })
      url.searchParams.set("expectedCommit", item.commit)
    }
    if (path === "/api/file") {
      const requested = url.searchParams.get("path")
      const recorded = recordedFile(url, requested)
      if (recorded?.error) return send(response, recorded.status, { error: recorded.error })
      if (recorded) {
        return send(response, 200, recorded.body, assetType(recorded.path), assetPolicy)
      }
      const found = resolveFile(requested, roots)
      if (found.error) return send(response, found.status, { error: found.error })
      // A design renders in a sandboxed frame; opened directly, the page is sandboxed too.
      return sendRange(request, response, found, { ...assetPolicy, "Content-Type": assetType(found.real) })
    }
    if (path === "/api/markdown") {
      const recorded = recordedFile(url)
      if (recorded?.error) return send(response, recorded.status, { error: recorded.error })
      if (recorded) return send(response, 200, renderDocument(resolve(roots[0].real, recorded.path), roots[0].real, recorded.body))
      const found = resolveFile(url.searchParams.get("path"), roots)
      if (found.error) return send(response, found.status, { error: found.error })
      try {
        return send(response, 200, renderDocument(found.real, roots[0].real, found.fd))
      } finally {
        closeSync(found.fd)
      }
    }
    if (path === "/api/outline") {
      const recorded = recordedFile(url)
      if (recorded?.error) return send(response, recorded.status, { error: recorded.error })
      if (recorded) return send(response, 200, OUTLINE_EXT.has(extname(recorded.path).toLowerCase())
        ? { supported: true, ...outlineOf(await loadTypeScript(), recorded.body.toString("utf8"), recorded.path) }
        : { supported: false })
      const found = resolveFile(url.searchParams.get("path"), roots)
      if (found.error) return send(response, found.status, { error: found.error })
      try {
        return send(response, 200, await outline(found))
      } finally {
        closeSync(found.fd)
      }
    }
    if (path === "/queue/") return send(response, 308, "", "text/plain", { Location: "/queue" + url.search })
    if (path === "/queue" && writeToken && !authorized(request)) return send(response, 401, "Sign in to review", "text/plain", { "WWW-Authenticate": 'Basic realm="Maintainer queue"' })
    if (path === "/queue") return sendFile(response, join(clientDir, "queue.html"))
    if (path.startsWith("/queue/")) {
      const name = path.slice("/queue/".length)
      if (!/^queue[\w.-]*\.(js|css)$/.test(name)) return send(response, 404, { error: "not found" })
      return sendFile(response, join(clientDir, name))
    }
    if (!existsSync(join(site, "index.html"))) return send(response, 404, "Build the site first: node apps/maintainer-site/build.mjs\n", "text/plain; charset=utf-8")
    let decoded
    try {
      decoded = decodeURIComponent(path)
    } catch {
      return send(response, 400, { error: "bad path" })
    }
    return staticUnder(response, site, decoded === "/" ? "/index.html" : decoded)
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (!response.headersSent) send(response, 500, { error: String(error.message ?? error) })
      else response.end()
    })
  })
  const ready = new Promise((resolveReady, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => resolveReady(`http://localhost:${server.address().port}`))
  })
  const close = () =>
    new Promise((resolveClose) => {
      clearInterval(ticker)
      clearInterval(keepAlive)
      clearTimeout(pending)
      clearTimeout(clientTimer)
      watcher.close()
      clientWatcher.close()
      for (const response of listeners) response.end()
      listeners.clear()
      server.closeAllConnections?.()
      server.close(() => resolveClose())
    })
  return { server, ready, close, queueFile, answersFile, emit, state }
}

// A Markdown file as a page, the way a README renders: links and images resolve beside the file and go through
// /api/file, so its refusals hold; raw HTML is sanitized by markdown.mjs.
export function renderDocument(file, repoReal, source = file) {
  const dir = dirname(file)
  const external = (href) => /^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)
  const target = (href) => {
    const hash = href.indexOf("#")
    let path = hash < 0 ? href : href.slice(0, hash)
    try {
      path = decodeURIComponent(path)
    } catch {}
    const absolute = resolve(dir, path)
    const inRepo = relative(repoReal, absolute)
    return { path: inRepo && !inRepo.startsWith("..") && !isAbsolute(inRepo) ? inRepo.split(sep).join("/") : absolute, anchor: hash < 0 ? "" : href.slice(hash) }
  }
  const { html, title } = renderMarkdown(Buffer.isBuffer(source) ? source.toString("utf8") : readFileSync(source, "utf8"), {
    link(href) {
      if (href.startsWith("#")) return { href }
      if (external(href)) {
        const safe = safeUrl(href)
        return safe ? { href: safe, cls: "ext", title: null } : { href: null, cls: "broken", title: "Unsafe link" }
      }
      const { path, anchor } = target(href)
      return { href: `/api/file?path=${encodeURIComponent(path)}${anchor}`, cls: "file", title: path }
    },
    image(src) {
      if (external(src)) return { href: safeUrl(src) }
      return { href: `/api/file?path=${encodeURIComponent(target(src).path)}` }
    },
  })
  return { html, title }
}

// The item's context as HTML. Repository paths open inline in the queue, never as a new page.
function renderContext(context) {
  if (typeof context !== "string" || context === "") return ""
  return renderMarkdown(context, {
    link(href) {
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) {
        const safe = safeUrl(href)
        return safe ? { href: safe, cls: "ext", title: null } : { href: null, cls: "broken", title: "Unsafe link" }
      }
      return { href: `/api/file?path=${encodeURIComponent(href.replace(/^\//, ""))}`, cls: "file", title: href }
    },
    image(src) {
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) return { href: safeUrl(src) }
      return { href: `/api/file?path=${encodeURIComponent(src)}` }
    },
  }).html
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { ready } = startServer()
  ready.then(
    (url) => console.log(`${url}/queue`),
    (error) => {
      console.error(error.message)
      process.exit(1)
    },
  )
}
