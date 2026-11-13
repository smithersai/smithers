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
import { closeSync, constants, createReadStream, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, statSync, watch, writeSync } from "node:fs"
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

const FORBIDDEN_SEGMENTS = new Set([".jj", ".git", "node_modules", ".ssh", ".gnupg", ".aws", ".docker", ".kube"])
const SECRET_FILE =
  /^(\.env.*|\.dev\.vars.*|\.npmrc|\.yarnrc.*|\.netrc|\.pypirc|\.htpasswd|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.[\w-]+)?|.*\.(pem|key|p12|pfx|jks|keystore|tfstate|tfstate\.backup|tfvars|kdbx|gpg|asc|age)|service[-_]?account.*\.json|.*private[-_]?key.*)$/i
const CODE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".md", ".mdx", ".css", ".html", ".swift", ".zig", ".py", ".sql"])
// Recordings and their chapter lists are named after tests ("auth-token-expires.mp4"), never secret stores.
const MEDIA_EXT = new Set([".gif", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg", ".mp4", ".webm", ".mov", ".m4v"])
// "secret", "token" or "password" in a file name marks a secret store unless the file is source code, docs or media
// (packages/secrets/src/Secret.ts is code; secrets.json is not).
const isSecretFileName = (name) =>
  /secret|token|passw(or)?d/i.test(name) && !CODE_EXT.has(extname(name).toLowerCase()) && !MEDIA_EXT.has(extname(name).toLowerCase()) && !/\.chapters\.json$/i.test(name)

export function refusalFor(segments) {
  for (const [index, segment] of segments.entries()) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return `refused: ${segment}`
    if (SECRET_FILE.test(segment) || (index === segments.length - 1 && isSecretFileName(segment))) return "refused: secret name"
  }
  return null
}

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

// Opens a checked file under the roots, or returns { status, error }. The caller owns the returned fd.
export function resolveFile(requested, roots) {
  if (typeof requested !== "string" || requested === "" || requested.includes("\0")) return { status: 400, error: "path required" }
  if (process.platform !== "linux" && process.platform !== "darwin")
    return { status: 403, error: "refused: secure file reads unavailable" }
  // Snapshot lazy root paths once for this authorization.
  roots = roots.map(({ path, real }) => ({ path, real }))
  const expanded = requested.startsWith("~/") ? join(homedir(), requested.slice(2)) : requested
  const candidates = isAbsolute(expanded) ? [resolve(expanded)] : [resolve(roots[0].path, expanded)]
  const target = candidates[0]
  // The path as asked must already sit inside a root, before symlinks are followed.
  const asked = roots.find((root) => target === root.path || target.startsWith(root.path + sep) || target === root.real || target.startsWith(root.real + sep))
  if (!asked) return { status: 403, error: "refused: outside the allowed roots" }
  const askedBase = target.startsWith(asked.real + sep) || target === asked.real ? asked.real : asked.path
  const askedRefusal = refusalFor(relative(askedBase, target).split(sep))
  if (askedRefusal) return { status: 403, error: askedRefusal }
  let real
  try {
    real = realpathSync(target)
  } catch {
    return { status: 404, error: "not found" }
  }
  // Symlinks are followed, so the real file must sit inside a root too.
  const root = roots.find((root) => real === root.real || real.startsWith(root.real + sep))
  if (!root) return { status: 403, error: "refused: outside the allowed roots" }
  const refusal = refusalFor(relative(root.real, real).split(sep))
  if (refusal) return { status: 403, error: refusal }
  let fd
  try {
    // Do not follow a symlink swapped in after realpath, including before the identity check.
    const checked = lstatSync(real)
    if (checked.isSymbolicLink()) return { status: 403, error: "refused: file changed" }
    if (!checked.isFile()) return { status: 404, error: "not a file" }
    if (checked.size > MAX_FILE) return { status: 413, error: "too large" }
    // Darwin's O_NOFOLLOW_ANY rejects a symlink in any component of the canonical path.
    // Node does not expose this flag; its value is defined in Darwin's sys/fcntl.h.
    const noFollowAny = process.platform === "darwin" ? 0x20000000 : 0
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | noFollowAny)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.dev !== checked.dev || stat.ino !== checked.ino)
      return { status: 403, error: "refused: file changed" }
    if (stat.size > MAX_FILE) return { status: 413, error: "too large" }
    if (process.platform === "linux") {
      // Inspect the held inode's kernel path, not a pathname that an ancestor swap can redirect.
      const opened = readlinkSync(`/proc/self/fd/${fd}`)
      if (!isAbsolute(opened) || opened.endsWith(" (deleted)"))
        return { status: 403, error: "refused: file changed" }
      const openedRoot = roots.find((root) => opened === root.real || opened.startsWith(root.real + sep))
      if (!openedRoot) return { status: 403, error: "refused: outside the allowed roots" }
      const openedRefusal = refusalFor(relative(openedRoot.real, opened).split(sep))
      if (openedRefusal) return { status: 403, error: openedRefusal }
    }
    const found = { real, fd, stat, size: stat.size }
    fd = undefined
    return found
  } catch (error) {
    return error.code === "ENOENT" || error.code === "ENOTDIR"
      ? { status: 404, error: "not found" }
      : { status: 403, error: "refused: file changed or unreadable" }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// ---------------------------------------------------------------------------------------------------------
// The queue: queue.json as the curator wrote it, minus what answers.jsonl hides.

export function readAnswers(file) {
  if (!existsSync(file)) return []
  const answers = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      const answer = JSON.parse(line)
      if (answer && typeof answer.itemId === "string" && ACTIONS.includes(answer.action)) answers.push(answer)
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
    if (answer.action === "undo") stack.pop()
    else stack.push(answer)
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
  if (!top) return false
  const at = Date.parse(top.at)
  if (item.addedAt && Date.parse(item.addedAt) > at) return false
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

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

export function startServer(options = {}) {
  const port = options.port ?? Number(process.env.PORT ?? 4747)
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

  // queue.json, cached by mtime and size; a parse failure keeps the last good copy.
  let cached = { key: "", queue: { version: 1, generatedAt: null, items: [] }, error: null }
  const readQueue = () => {
    let stat
    try {
      stat = statSync(queueFile)
    } catch {
      return { version: 1, generatedAt: null, items: [], missing: true }
    }
    const key = `${stat.mtimeMs}:${stat.size}`
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
    let coverage
    try { coverage = JSON.parse(readFileSync(coverageFile, "utf8")).slices?.[id] } catch {}
    const commit = item?.commit || coverage?.commit
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
    const visible = queue.items.filter((item) => !isHidden(item, stacks, at))
    return { queue, answers, stacks, last, visible, at }
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
    const { queue, stacks, visible, at } = state()
    const today = new Date(at)
    let doneToday = 0
    for (const stack of stacks.values()) for (const answer of stack) if (DONE_ACTIONS.has(answer.action) && sameDay(new Date(answer.at), today)) doneToday++
    const remaining = {}
    for (const item of visible) remaining[item.kind] = (remaining[item.kind] ?? 0) + 1
    let coverage = null
    try {
      coverage = coveragePercent(JSON.parse(readFileSync(coverageFile, "utf8")))
    } catch {}
    return { doneToday, remaining, total: visible.length, all: queue.items.length, coverage }
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
  const sendRange = (request, response, { real, fd, size }, extraHeaders) => {
    let streaming = false
    try {
      const ext = extname(real).toLowerCase()
      let type = TYPES[ext]
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
      const stream = createReadStream(null, { fd, start, end })
      streaming = true
      stream.on("error", () => response.destroy())
      response.on("close", () => stream.destroy())
      stream.pipe(response)
    } finally {
      // A stream owns and closes its descriptor. All responses without one close it here.
      if (!streaming) closeSync(fd)
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
    const realBase = realpathSync(base)
    if (real !== realBase && !real.startsWith(realBase + sep)) return send(response, 403, { error: "refused" })
    return sendFile(response, real)
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
  const queued = (item, answers) => (item.kind === "verify" ? { ...item, verifies: verifies(item.answerRef, answers) } : item)

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
    // The curator replaced the item after Will opened it: refuse, and send the version now queued.
    if (item && action !== "undo" && VERSION_FIELDS.some((field) => (input[field] ?? null) !== (item[field] ?? null)))
      return send(response, 409, { error: "changed since you opened it", item: queued(item, current.answers) })
    const record = {
      itemId,
      at: new Date(now()).toISOString(),
      action,
      ...(action === "option" ? { option: input.option } : {}),
      ...(input.scope === "all" && action !== "undo" ? { scope: "all", kind: item?.kind ?? (typeof input.kind === "string" ? input.kind.slice(0, 40) : null) } : {}),
      text,
      revision: item?.revision ?? (typeof input.revision === "string" ? input.revision : undone?.revision ?? null),
      title: item?.title ?? (typeof input.title === "string" ? input.title.slice(0, 200) : undone?.title ?? ""),
    }
    append(record)
    emit()
    return send(response, 200, { ok: true, answer: record })
  }

  const handle = async (request, response) => {
    if (!allowedHosts().has(String(request.headers.host ?? "").toLowerCase())) return send(response, 403, { error: "refused: host" })
    const url = new URL(request.url, `http://${request.headers.host}`)
    const path = url.pathname
    if (request.method === "POST") {
      const origin = request.headers.origin
      if (origin !== undefined && !allowedHosts().has(origin.replace(/^http:\/\//, "").toLowerCase())) return send(response, 403, { error: "refused: origin" })
      if (path === "/api/answer") return answer(request, response)
      return send(response, 404, { error: "not found" })
    }
    if (request.method !== "GET" && request.method !== "HEAD") return send(response, 405, { error: "method not allowed" })

    if (path === "/api/queue") {
      const { queue, visible, last, answers } = state()
      const items = visible.map((item) => queued(item, answers))
      return send(response, 200, { version: queue.version, generatedAt: queue.generatedAt, missing: Boolean(queue.missing), error: cached.error, items, last: last ? { itemId: last.itemId, title: last.title ?? "", action: last.action, at: last.at } : null })
    }
    if (path === "/api/stats") return send(response, 200, stats())
    if (path === "/api/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" })
      response.write(`retry: 1000\n\nevent: client\ndata: ${JSON.stringify({ version: clientVersion() })}\n\n`)
      listeners.add(response)
      request.on("close", () => listeners.delete(response))
      return
    }
    if (path === "/api/file" || path.startsWith("/api/file/")) {
      let requested = url.searchParams.get("path")
      if (path.startsWith("/api/file/")) {
        try {
          requested = decodeURIComponent(path.slice("/api/file/".length))
        } catch {
          return send(response, 400, { error: "bad path" })
        }
      }
      const recorded = recordedFile(url, requested)
      if (recorded?.error) return send(response, recorded.status, { error: recorded.error })
      if (recorded) {
        response.writeHead(200, { "Content-Type": TYPES[extname(recorded.path)] ?? "text/plain; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "sandbox allow-scripts" })
        return response.end(recorded.body)
      }
      const found = resolveFile(requested, roots)
      if (found.error) return send(response, found.status, { error: found.error })
      // A design renders in a sandboxed frame; opened directly, the page is sandboxed too.
      return sendRange(request, response, found, { "Content-Security-Policy": "sandbox allow-scripts" })
    }
    if (path === "/api/markdown") {
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
    if (path === "/queue" || path === "/queue/") return sendFile(response, join(clientDir, "queue.html"))
    if (path.startsWith("/queue/")) {
      const name = path.slice("/queue/".length)
      if (!/^queue[\w.-]*\.(js|css)$/.test(name)) return send(response, 404, { error: "not found" })
      return sendFile(response, join(clientDir, name))
    }
    if (!existsSync(join(site, "index.html"))) return send(response, 404, "Build the site first: node apps/maintainer-site/build.mjs\n", "text/plain; charset=utf-8")
    return staticUnder(response, site, path === "/" ? "/index.html" : decodeURIComponent(path))
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
  return { server, ready, close, queueFile, answersFile, emit }
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
  const { html, title } = renderMarkdown(readFileSync(source, "utf8"), {
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
