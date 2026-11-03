#!/usr/bin/env node
// Creates the collected records (collect.mjs) as issues on a repository through Smithers' own writes route, as the
// signed-in test person, inside GitHub's secondary limits for content creation: at most 80 a minute and 500 an hour
// (docs.github.com, "Rate limits for the REST API", checked 2026-11-02). It sends one write every `--every` seconds
// (default 7.5, so 480 an hour), and on 429 or 503 waits the `retry-after` it was given, else a minute, doubling.
//
//   node ops/issue-tracking/seed.mjs --repo <owner>/<name> [--records <file>] [--state <file>] [--every 7.5]
//
// Resumable: each record's write id is a UUIDv5 of its key, so sending it again is the same write (the route answers
// 200), and the state file records each key sent. The session is the production e2e person's
// (~/.smithers-e2e/<host>/session.json, identity.json); nothing here prints a cookie, a title or a body.
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { parseArgs } from "node:util"
import { refuseUncheckedTls } from "../tls.mjs"

refuseUncheckedTls(process.env)
const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    origin: { type: "string", default: "https://smithers.sh" },
    records: { type: "string", default: `${homedir()}/.smithers-e2e/smithers.sh/issue-tracking/records.jsonl` },
    state: { type: "string", default: `${homedir()}/.smithers-e2e/smithers.sh/issue-tracking/seed-state.jsonl` },
    every: { type: "string", default: "7.5" },
    "locked-every": { type: "string", default: "30" },
    limit: { type: "string" },
  },
})
if (values.repo === undefined || !/^[\w.-]+\/[\w.-]+$/.test(values.repo)) throw new Error("--repo <owner>/<name> is required")
const host = new URL(values.origin).host
const dir = `${homedir()}/.smithers-e2e/${host}`

/** UUIDv5 of `name` in a fixed namespace: the same record is always the same write. */
export const writeIdOf = (name) => {
  const namespace = Buffer.from("6c1b4f1e9a3d4b7e8f2a5c6d7e8f9a0b", "hex")
  const hash = createHash("sha1").update(Buffer.concat([namespace, Buffer.from(name)])).digest()
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const session = JSON.parse(readFileSync(`${dir}/session.json`, "utf8"))
const person = JSON.parse(readFileSync(`${dir}/identity.json`, "utf8")).personId
const cookie = session.cookies
  .filter((c) => host.endsWith(c.domain.replace(/^\./, "")))
  .map((c) => `${c.name}=${c.value}`)
  .join("; ")
const headers = { cookie, origin: values.origin, "x-smithers-device-person": person, "content-type": "application/json" }

const sent = new Set(
  existsSync(values.state)
    ? readFileSync(values.state, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).key)
    : [],
)
const records = readFileSync(values.records, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
const todo = records.filter((record) => !sent.has(record.key)).slice(0, values.limit === undefined ? undefined : Number(values.limit))
const every = Number(values.every) * 1000
const lockedEvery = Number(values["locked-every"]) * 1000
let slowed = false
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const [owner, name] = values.repo.split("/")
const route = `${values.origin}/api/repos/${owner}/${name}/writes`
const startedAt = Date.now()
console.log(JSON.stringify({ event: "start", repo: values.repo, already: sent.size, todo: todo.length, everyMs: every }))

let backoff = 60_000
for (const [index, record] of todo.entries()) {
  const writeId = writeIdOf(`${values.repo}:${record.key}`)
  // The seed writes as the e2e test person: while a production e2e run holds its lock (e2e/prod.mjs's `run.lock`), it
  // slows to one write every `--locked-every` seconds (30 unless set), so its writes barely queue beside the run's own.
  // Each change of pace is logged, so the seed's time says how much of it ran slowed.
  const locked = existsSync(`${dir}/run.lock`)
  if (locked !== slowed) {
    slowed = locked
    console.log(JSON.stringify({ event: locked ? "slow" : "fast", at: new Date().toISOString(), everyS: (locked ? lockedEvery : every) / 1000 }))
  }
  for (;;) {
    const at = Date.now()
    const response = await fetch(route, {
      method: "POST",
      headers,
      body: JSON.stringify({ writeId, op: "issue/create", title: record.title, body: record.body }),
    }).catch(() => undefined)
    const status = response?.status ?? 0
    if (status === 200 || status === 202) {
      appendFileSync(values.state, JSON.stringify({ key: record.key, writeId, status, at: new Date(at).toISOString() }) + "\n", { mode: 0o600 })
      backoff = 60_000
      if ((index + 1) % 50 === 0) {
        console.log(JSON.stringify({ event: "progress", sent: sent.size + index + 1, elapsedS: Math.round((Date.now() - startedAt) / 1000) }))
      }
      await sleep(Math.max(0, (slowed ? lockedEvery : every) - (Date.now() - at)))
      break
    }
    const code = await response?.clone().json().then((body) => body?.code, () => undefined)
    // 403 and 429 can be GitHub's secondary limit or a transient role re-read: they wait as a 503 does, by `retry-after`,
    // else `x-ratelimit-reset`, else at least a minute, doubling up to 30 minutes.
    if (status === 401 || status === 404 || status === 400 || status === 413) {
      console.log(JSON.stringify({ event: "refused", key: record.key, status, code }))
      process.exit(1)
    }
    const retryAfter = Number(response?.headers.get("retry-after"))
    const reset = Number(response?.headers.get("x-ratelimit-reset")) * 1000 - Date.now()
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Number.isFinite(reset) && reset > 0 ? reset : backoff
    console.log(JSON.stringify({ event: "wait", status, code, waitS: Math.round(wait / 1000) }))
    await sleep(wait)
    backoff = Math.min(backoff * 2, 30 * 60_000)
  }
}
console.log(JSON.stringify({ event: "done", sent: sent.size + todo.length, elapsedS: Math.round((Date.now() - startedAt) / 1000) }))
