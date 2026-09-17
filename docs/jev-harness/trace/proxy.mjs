// Logging proxy: 127.0.0.1:4096 -> 127.0.0.1:4098. Node stdlib only.
// Logs requests to requests.ndjson and SSE data lines to events.ndjson.
// POST /__marker {step, note} writes a marker line to both files (not forwarded).
// BLOCK_LEGACY_HEALTH=1 answers GET /global/health with 404 so the app picks v2.
import http from "node:http"
import fs from "node:fs"
import path from "node:path"

const DIR = path.dirname(new URL(import.meta.url).pathname)
const UP_HOST = "127.0.0.1"
const UP_PORT = Number(process.env.UPSTREAM_PORT ?? 4098)
const PORT = Number(process.env.PROXY_PORT ?? 4096)
const BLOCK_LEGACY_HEALTH = process.env.BLOCK_LEGACY_HEALTH === "1"
const REQ_LOG = fs.createWriteStream(path.join(DIR, process.env.REQ_LOG ?? "requests.ndjson"), { flags: "a" })
const EVT_LOG = fs.createWriteStream(path.join(DIR, process.env.EVT_LOG ?? "events.ndjson"), { flags: "a" })
let seq = 0
let step = "pre"
const REQ_CAP = 8 * 1024
const RES_CAP = 16 * 1024

function parseBody(buf, contentType, cap) {
  if (!buf || buf.length === 0) return undefined
  const text = buf.toString("utf8")
  const cut = text.length > cap ? text.slice(0, cap) : text
  if ((contentType ?? "").includes("application/json")) {
    try {
      const v = JSON.parse(text)
      return text.length > cap ? { _truncated: true, _bytes: text.length, preview: cut } : v
    } catch {}
  }
  return text.length > cap ? { _truncated: true, _bytes: text.length, preview: cut } : cut
}

function log(stream, obj) {
  stream.write(JSON.stringify(obj) + "\n")
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${UP_HOST}:${UP_PORT}`)
  if (req.method === "POST" && url.pathname === "/__marker") {
    let b = []
    req.on("data", (c) => b.push(c))
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(b).toString("utf8") || "{}")
      step = body.step ?? step
      const line = { marker: true, step, note: body.note ?? "", at: new Date().toISOString() }
      log(REQ_LOG, line)
      log(EVT_LOG, line)
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" })
      res.end("{}")
    })
    return
  }
  const mySeq = ++seq
  const started = Date.now()
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    const reqBuf = Buffer.concat(chunks)
    // SHIM_V2=1: answer the v2 routes the hosted app's vendored client (1.17.13-v2) calls but no current server serves.
    if (process.env.SHIM_V2 === "1" && req.method === "GET") {
      const loc = url.searchParams.get("location[directory]") ?? process.env.SHIM_DIRECTORY ?? ""
      const project = { id: process.env.SHIM_PROJECT_ID ?? "shim", directory: loc }
      const location = { directory: loc, project }
      const shims = {
        "/api/model/default": { location, data: null },
        "/api/project": [],
        "/api/project/current": { id: project.id, directory: loc },
        "/api/mcp": { location, data: [] },
        "/api/mcp/resource": { location, data: { resources: [], templates: [] } },
      }
      if (url.pathname in shims) {
        const body = JSON.stringify(shims[url.pathname])
        const origin = req.headers.origin
        const h = { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
        if (origin) {
          h["access-control-allow-origin"] = origin
          h["access-control-allow-credentials"] = "true"
          h["vary"] = "Origin"
        }
        res.writeHead(200, h)
        res.end(body)
        log(REQ_LOG, { seq: mySeq, step, at: new Date(started).toISOString(), method: req.method, path: url.pathname, query: url.search.slice(1) || undefined, origin, status: 200, resContentType: "application/json", resBody: JSON.parse(body), proxyShim: true, ms: Date.now() - started })
        return
      }
    }
    if (BLOCK_LEGACY_HEALTH && url.pathname === "/global/health") {
      const origin = req.headers.origin
      const h = { "content-type": "text/plain" }
      if (origin) {
        h["access-control-allow-origin"] = origin
        h["access-control-allow-credentials"] = "true"
        h["vary"] = "Origin"
      }
      res.writeHead(404, h)
      res.end("blocked by proxy")
      log(REQ_LOG, { seq: mySeq, step, at: new Date(started).toISOString(), method: req.method, path: url.pathname, query: url.search.slice(1) || undefined, origin, reqBody: undefined, status: 404, resContentType: "text/plain", resBody: "blocked by proxy", proxyBlocked: true, ms: Date.now() - started })
      return
    }
    // SHIM_V2_WRITES=1: adapt the hosted app's 1.17.13-v2 write bodies to main's protocol so a turn can run.
    let sendBuf = reqBuf
    let rewrite
    if (process.env.SHIM_V2_WRITES === "1" && req.method === "POST" && (req.headers["content-type"] ?? "").includes("application/json")) {
      try {
        const body = JSON.parse(reqBuf.toString("utf8") || "{}")
        if (url.pathname === "/api/session" && body.model) {
          rewrite = { from: body.model, to: { id: "big-pickle", providerID: "opencode" } }
          body.model = rewrite.to
          sendBuf = Buffer.from(JSON.stringify(body))
        } else if (/^\/api\/session\/[^/]+\/prompt$/.test(url.pathname) && !("prompt" in body) && typeof body.text === "string") {
          const { id, text, files, agents, ...rest } = body
          const wrapped = { ...(id ? { id } : {}), prompt: { text, ...(files?.length ? { files } : {}), ...(agents?.length ? { agents } : {}) }, ...rest }
          rewrite = { from: body, to: wrapped }
          sendBuf = Buffer.from(JSON.stringify(wrapped))
        }
      } catch {}
    }
    const fwdHeaders = { ...req.headers, host: `${UP_HOST}:${UP_PORT}`, "accept-encoding": "identity" }
    if (sendBuf !== reqBuf) fwdHeaders["content-length"] = String(sendBuf.length)
    const upstream = http.request(
      { host: UP_HOST, port: UP_PORT, method: req.method, path: req.url, headers: fwdHeaders },
      (up) => {
        const ct = up.headers["content-type"] ?? ""
        if (process.env.SHIM_V2 === "1" && url.pathname === "/api/agent" && ct.includes("application/json")) {
          const parts = []
          up.on("data", (c) => parts.push(c))
          up.on("end", () => {
            let body = Buffer.concat(parts).toString("utf8")
            let fixed = 0
            try {
              const v = JSON.parse(body)
              if (Array.isArray(v.data)) {
                v.data = v.data.map((a) => {
                  if (!a || typeof a !== "object") return a
                  const request = a.request && typeof a.request === "object" ? a.request : {}
                  const needs = !("request" in a) || !request.settings || !("name" in a)
                  if (!needs) return a
                  fixed++
                  return { ...a, name: a.name ?? a.id, request: { settings: request.settings ?? {}, headers: request.headers ?? {}, body: request.body ?? {} }, permissions: a.permissions ?? [] }
                })
              }
              body = JSON.stringify(v)
            } catch {}
            const h = { ...up.headers, "content-length": Buffer.byteLength(body) }
            delete h["transfer-encoding"]
            res.writeHead(up.statusCode, h)
            res.end(body)
            log(REQ_LOG, { seq: mySeq, step, at: new Date(started).toISOString(), method: req.method, path: url.pathname, query: url.search.slice(1) || undefined, origin: req.headers.origin, status: up.statusCode, resContentType: ct, resBody: parseBody(Buffer.from(body), ct, RES_CAP), proxyPatchedAgents: fixed, ms: Date.now() - started })
          })
          return
        }
        if (BLOCK_LEGACY_HEALTH && url.pathname === "/api/health" && ct.includes("application/json")) {
          const parts = []
          up.on("data", (c) => parts.push(c))
          up.on("end", () => {
            let body = Buffer.concat(parts).toString("utf8")
            try {
              const v = JSON.parse(body)
              if (typeof v.pid !== "number") v.pid = Number(process.env.UPSTREAM_PID ?? process.pid)
              body = JSON.stringify(v)
            } catch {}
            const h = { ...up.headers, "content-length": Buffer.byteLength(body) }
            delete h["transfer-encoding"]
            res.writeHead(up.statusCode, h)
            res.end(body)
            log(REQ_LOG, { seq: mySeq, step, at: new Date(started).toISOString(), method: req.method, path: url.pathname, query: url.search.slice(1) || undefined, origin: req.headers.origin, status: up.statusCode, resContentType: ct, resBody: JSON.parse(body), proxyInjectedPid: true, ms: Date.now() - started })
          })
          return
        }
        res.writeHead(up.statusCode, up.headers)
        const base = {
          seq: mySeq,
          step,
          at: new Date(started).toISOString(),
          method: req.method,
          path: url.pathname,
          query: url.search.slice(1) || undefined,
          origin: req.headers.origin,
          reqContentType: req.headers["content-type"],
          reqBody: parseBody(reqBuf, req.headers["content-type"], REQ_CAP),
          ...(rewrite ? { proxyRewroteBodyTo: rewrite.to } : {}),
          status: up.statusCode,
          resContentType: ct,
        }
        if (ct.includes("text/event-stream")) {
          log(REQ_LOG, { ...base, resBody: "<sse stream>", sse: true })
          let buffer = ""
          let evtIdx = 0
          up.on("data", (chunk) => {
            res.write(chunk)
            buffer += chunk.toString("utf8")
            let idx
            while ((idx = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, idx).replace(/\r$/, "")
              buffer = buffer.slice(idx + 1)
              if (line.startsWith("data:")) {
                const raw = line.slice(5).trim()
                let event
                try {
                  event = JSON.parse(raw)
                } catch {
                  event = { _raw: raw }
                }
                log(EVT_LOG, { seq: mySeq, idx: ++evtIdx, step, at: new Date().toISOString(), path: url.pathname, event })
              } else if (line.startsWith(":") || line.startsWith("event:") || line.startsWith("id:") || line.startsWith("retry:")) {
                log(EVT_LOG, { seq: mySeq, idx: ++evtIdx, step, at: new Date().toISOString(), path: url.pathname, sseLine: line })
              }
            }
          })
          up.on("end", () => {
            log(EVT_LOG, { seq: mySeq, step, at: new Date().toISOString(), path: url.pathname, streamEnd: true })
            res.end()
          })
          up.on("error", () => res.end())
          return
        }
        const out = []
        up.on("data", (c) => {
          out.push(c)
          res.write(c)
        })
        up.on("end", () => {
          res.end()
          const resBuf = Buffer.concat(out)
          log(REQ_LOG, { ...base, resBody: parseBody(resBuf, ct, RES_CAP), ms: Date.now() - started })
        })
        up.on("error", () => res.end())
      },
    )
    upstream.on("error", (err) => {
      log(REQ_LOG, { seq: mySeq, step, method: req.method, path: url.pathname, query: url.search.slice(1) || undefined, error: String(err) })
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" })
      res.end("proxy error: " + err.message)
    })
    req.on("close", () => {
      if (!upstream.destroyed && !upstream.writableEnded) upstream.destroy()
    })
    if (sendBuf.length) upstream.write(sendBuf)
    upstream.end()
  })
})
server.on("clientError", (err, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"))
server.listen(PORT, "127.0.0.1", () => {
  console.log(`proxy listening on http://127.0.0.1:${PORT} -> http://${UP_HOST}:${UP_PORT} blockLegacyHealth=${BLOCK_LEGACY_HEALTH}`)
})
