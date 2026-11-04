// A fake smithers.sh on one local port, for the `issues/file-tree` flow's tests: the machine-write and work-link routes,
// with writes in memory and every request logged. A write settles at once unless told otherwise. `script(match, answers)`
// queues answers; `hold(match)` keeps the next match until `release()`, after the fake has done its work, so a test can
// kill the flow right after a send.
import { createServer } from "node:http"
import { escapeMarkdown } from "../../../../apps/mvp/src/features/issues/publicContent.mjs"

/** Each live token and the agent and lane it was issued to; the plan and code tokens share one lane. */
export const LANES = {
  [`smm_${"p".repeat(43)}`]: "filer/lane-1",
  [`smm_${"c".repeat(43)}`]: "filer/lane-1",
}

export const startFakeSmithers = ({ liveTokens = Object.keys(LANES), lanes = LANES } = {}) => new Promise((ready) => {
  const writes = new Map() // writeId -> { repo, op, body, status, failure, number }
  const links = new Map() // `${repo}#${number} ${kind} ${ref}` -> link
  const log = [] // { method, path, at }
  const scripts = []
  const numbers = new Map()
  let held
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers })
    res.end(JSON.stringify(body))
  }
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", async () => {
      const url = new URL(req.url, "http://fake")
      const path = url.pathname
      const body = raw === "" ? undefined : JSON.parse(raw)
      log.push({ method: req.method, path, at: Date.now(), writeId: body?.writeId, offset: url.searchParams.get("offset") })
      const scripted = scripts.find((s) => s.match(req.method, path) && s.answers.length > 0)
      if (scripted !== undefined) {
        const [status, answer, headers] = scripted.answers.shift()
        if (status === "reset") return req.socket.destroy()
        if (status === "reset-body") {
          res.writeHead(200, { "content-type": "application/json", "electric-offset": "lost-page", "electric-handle": "lost-handle" })
          res.write("[")
          setTimeout(() => res.destroy(), 10)
          return
        }
        return json(res, status, answer, headers)
      }
      // The issues shape, signed out, as Electric sends it: every issue a create made, then up to date.
      if (req.method === "GET" && path === "/api/shapes/items") {
        const repo = url.searchParams.get("repo")
        const rows = [...writes.values()].filter((write) => write.op === "issue/create" && write.repo === repo && write.status === "done")
          .map((write) => ({ headers: { operation: "insert" }, key: `${repo}#${write.number}`, value: { number: String(write.number), body: escapeMarkdown(write.body), title: write.title, state: "open", kind: "issue" } }))
        return json(res, 200, [...rows, ...api.shapeExtra.filter((row) => row.repo === repo).map((row) => ({ headers: { operation: "insert" }, key: row.key, value: row.value })), { headers: { control: "up-to-date" } }], { "electric-offset": "0_0", "electric-handle": "h" })
      }
      const bearer = req.headers.authorization?.replace("Bearer ", "")
      if (!liveTokens.includes(bearer) || api.revoked.has(bearer)) return json(res, 401, { code: "authentication" })
      let m
      let answer
      if ((m = /^\/api\/repos\/([^/]+)\/([^/]+)\/writes$/.exec(path))) {
        const repo = `${m[1]}/${m[2]}`
        const existing = writes.get(body.writeId)
        api.submissions.set(body.writeId, (api.submissions.get(body.writeId) ?? 0) + 1)
        const { writeId: _, ...payload } = body
        // As the server does: the same id from another agent and lane, another repository or with another payload is a
        // conflict. A new token for the same lane is the same writer.
        if (existing !== undefined && (existing.lane !== lanes[bearer] || existing.repo !== repo || existing.payload !== JSON.stringify(payload))) answer = [409, { code: "conflict" }]
        else if (existing !== undefined) answer = [200, { writeId: body.writeId, status: existing.status }]
        else {
          const number = body.op === "issue/create" ? (numbers.set(repo, (numbers.get(repo) ?? 0) + 1), numbers.get(repo)) : body.number
          writes.set(body.writeId, { repo, ...body, lane: lanes[bearer], token: bearer, payload: JSON.stringify(payload), status: api.pending(body) ? "pending" : "done", failure: null, number })
          api.afterWrite?.(writes.get(body.writeId))
          answer = [202, { writeId: body.writeId }]
        }
      } else if ((m = /^\/api\/repos\/([^/]+)\/([^/]+)\/writes\/([0-9a-f-]+)$/.exec(path))) {
        const write = writes.get(m[3])
        // As the server does: a pending write keeps the token it was sent with, and a revoked one settles it refused.
        if (write !== undefined && write.status === "pending" && api.revoked.has(write.token)) Object.assign(write, { status: "refused", failure: "revoked" })
        if (write !== undefined && write.status === "pending" && !api.pending(write)) write.status = "done"
        answer = write === undefined ? [404, { code: "not_found" }] : [200, { status: write.status, failure: write.failure, number: write.number }]
      } else if ((m = /^\/api\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/links$/.exec(path))) {
        // As the server does: 1 to 50 links to a request.
        if (!Array.isArray(body.links) || body.links.length < 1 || body.links.length > 50) return json(res, 400, { code: "invalid" })
        api.linkBatches.push(body.links.length)
        for (const link of body.links) links.set(`${m[1]}/${m[2]}#${m[3]} ${link.kind} ${link.ref}`, link)
        answer = [200, { links: body.links.length, changed: body.links.length }]
      } else answer = [404, { path }]
      if (held !== undefined && held.match(req.method, path)) {
        const gate = held
        held = undefined
        gate.arrived()
        await gate.released
      }
      json(res, answer[0], answer[1])
    })
  })
  const api = {
    /** Whether a write stays pending for now; read again at each look. */
    pending: () => false,
    /** Tokens no longer live: an expired token, before its lane's new one. */
    revoked: new Set(),
    /** The size of each work-link request, in order. */
    linkBatches: [],
    /** Each write id's submissions, repeats included. */
    submissions: new Map(),
    /** Shape rows a test adds: issues filed some other way. */
    shapeExtra: [],
    origin: "",
    writes,
    links,
    log,
    script: (match, answers) => scripts.push({ match, answers: [...answers] }),
    hold: (match) => {
      let arrived
      let release
      held = { match, released: new Promise((r) => (release = r)) }
      const came = new Promise((r) => (arrived = r))
      held.arrived = arrived
      return { came, release: () => release() }
    },
    posts: (pattern) => log.filter((entry) => entry.method === "POST" && pattern.test(entry.path)),
    close: () => new Promise((r) => server.close(r)),
    /** Runs on each new write, to settle it another way. */
    afterWrite: undefined,
  }
  server.listen(0, "127.0.0.1", () => {
    api.origin = `http://127.0.0.1:${server.address().port}`
    ready(api)
  })
})
