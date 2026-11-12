#!/usr/bin/env node
// Creates the collected records (collect.mjs) as issues on a repository through Smithers' own writes route, as the
// signed-in test person, inside GitHub's secondary limits for content creation: at most 80 a minute and 500 an hour
// (docs.github.com, "Rate limits for the REST API", checked 2026-11-02). It sends one new write every `--every` seconds
// (default 7.5, so 480 an hour), and on 429 or 503 waits the `retry-after` it was given, else a minute, doubling.
//
//   node ops/issue-tracking/seed.mjs --repo <owner>/<name> [--records <file>] [--state <file>] [--every 7.5]
//
// Resumable: each record's write id is a UUIDv5 of its key, so sending it again is the same write, and the route answers
// how it stands (200 with its status). The state file holds one admission line per key sent (`{ key, writeId, status,
// at }`, `status` the HTTP answer) and a settlement line (`{ key, writeId, settled, at }`) once the write is `done`,
// `failed` or `refused`. A run sends the records not yet admitted, then resends every admitted write that isn't `done`
// until each settles or 30 minutes pass. It ends with `done` only when every admitted write is done; otherwise with
// `unsettled`, naming each failed or refused write, and exit code 1. A rerun watches the pending ones again and reports
// the failed ones again; a failed write stays failed under its write id. The session is the production e2e person's
// (~/.smithers-e2e/<host>/session.json, identity.json); nothing here prints a cookie, a title or a body.
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { parseArgs } from "node:util"
import { refuseUncheckedTls } from "../tls.mjs"

refuseUncheckedTls(process.env)

/** How often, and how many times, a run resends its unsettled writes before it ends. */
export const WATCH_EVERY_MS = 30_000
export const WATCH_ROUNDS = 60

/** UUIDv5 of `name` in a fixed namespace: the same record is always the same write. */
export const writeIdOf = (name) => {
  const namespace = Buffer.from("6c1b4f1e9a3d4b7e8f2a5c6d7e8f9a0b", "hex")
  const hash = createHash("sha1").update(Buffer.concat([namespace, Buffer.from(name)])).digest()
  hash[6] = (hash[6] & 0x0f) | 0x50
  hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The keys admitted, and each key's last settlement, from the state file's lines. */
export const stateOf = (lines) => {
  const admitted = new Set()
  const settled = new Map()
  for (const line of lines) {
    if (line.settled === undefined) admitted.add(line.key)
    else settled.set(line.key, line.settled)
  }
  return { admitted, settled }
}

/**
 * Seeds `records` on `repo`. `fetch`, `sleep`, `locked` (whether a production e2e run holds its lock) and `log` are the
 * run's only contact with the world besides the state file at `state`. Answers the final record.
 */
export const seed = async ({ repo, origin, records, state, every, lockedEvery, limit, headers, fetch, sleep, locked, log }) => {
  const { admitted, settled } = stateOf(existsSync(state) ? readFileSync(state, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [])
  const save = (line) => appendFileSync(state, JSON.stringify(line) + "\n", { mode: 0o600 })
  const todo = records.filter((record) => !admitted.has(record.key)).slice(0, limit)
  const watching = records.filter((record) => admitted.has(record.key) && settled.get(record.key) !== "done")
  const [owner, name] = repo.split("/")
  const route = `${origin}/api/repos/${owner}/${name}/writes`
  const startedAt = Date.now()
  log({ event: "start", repo, already: admitted.size, todo: todo.length, watching: watching.length, everyMs: every })

  let backoff = 60_000
  /** Sends `record`'s write until the route answers it: `202` for a new write, else `200` with how it stands. */
  const send = async (record) => {
    for (;;) {
      const at = Date.now()
      const response = await fetch(route, {
        method: "POST",
        headers,
        body: JSON.stringify({ writeId: writeIdOf(`${repo}:${record.key}`), op: "issue/create", title: record.title, body: record.body }),
      }).catch(() => undefined)
      const status = response?.status ?? 0
      const answer = await response?.clone().json().catch(() => undefined)
      if (status === 200 || status === 202) {
        backoff = 60_000
        return { at, status, write: status === 202 ? "pending" : answer?.status ?? "pending" }
      }
      // 403 and 429 can be GitHub's secondary limit or a transient role re-read: they wait as a 503 does, by `retry-after`,
      // else `x-ratelimit-reset`, else at least a minute, doubling up to 30 minutes.
      if (status === 401 || status === 404 || status === 400 || status === 413) {
        log({ event: "refused", key: record.key, status, code: answer?.code })
        throw new Error(`the writes route refused ${record.key}: HTTP ${status}`)
      }
      const retryAfter = Number(response?.headers.get("retry-after"))
      const reset = Number(response?.headers.get("x-ratelimit-reset")) * 1000 - Date.now()
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Number.isFinite(reset) && reset > 0 ? reset : backoff
      log({ event: "wait", status, code: answer?.code, waitS: Math.round(wait / 1000) })
      await sleep(wait)
      backoff = Math.min(backoff * 2, 30 * 60_000)
    }
  }
  const failed = new Map()
  /** Records a settled write; answers whether it settled. */
  const settle = (record, writeId, write) => {
    if (write === "pending") return false
    save({ key: record.key, writeId, settled: write, at: new Date().toISOString() })
    if (write === "done") return true
    failed.set(record.key, write)
    log({ event: "failed", key: record.key, writeId, status: write })
    return true
  }

  let slowed = false
  const pending = [...watching]
  for (const [index, record] of todo.entries()) {
    const writeId = writeIdOf(`${repo}:${record.key}`)
    // The seed writes as the e2e test person: while a production e2e run holds its lock (e2e/prod.mjs's `run.lock`), it
    // slows to one write every `--locked-every` seconds (30 unless set), so its writes barely queue beside the run's own.
    // Each change of pace is logged, so the seed's time says how much of it ran slowed.
    const isLocked = locked()
    if (isLocked !== slowed) {
      slowed = isLocked
      log({ event: isLocked ? "slow" : "fast", at: new Date().toISOString(), everyS: (isLocked ? lockedEvery : every) / 1000 })
    }
    const { at, status, write } = await send(record)
    save({ key: record.key, writeId, status, at: new Date(at).toISOString() })
    if (!settle(record, writeId, write)) pending.push(record)
    if ((index + 1) % 50 === 0) log({ event: "progress", sent: admitted.size + index + 1, elapsedS: Math.round((Date.now() - startedAt) / 1000) })
    await sleep(Math.max(0, (slowed ? lockedEvery : every) - (Date.now() - at)))
  }
  // A write the route admitted settles on its own run; resending it reads how it stands and creates nothing.
  for (let round = 0; pending.length > 0 && round < WATCH_ROUNDS; round++) {
    if (round > 0) await sleep(WATCH_EVERY_MS)
    for (const record of pending.splice(0)) {
      if (!settle(record, writeIdOf(`${repo}:${record.key}`), (await send(record)).write)) pending.push(record)
    }
  }
  const sent = admitted.size + todo.length
  const final = {
    event: pending.length === 0 && failed.size === 0 ? "done" : "unsettled",
    sent,
    done: sent - pending.length - failed.size,
    pending: pending.length,
    failed: failed.size,
    elapsedS: Math.round((Date.now() - startedAt) / 1000),
  }
  log(final)
  return final
}

const main = async () => {
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
  const session = JSON.parse(readFileSync(`${dir}/session.json`, "utf8"))
  const person = JSON.parse(readFileSync(`${dir}/identity.json`, "utf8")).personId
  const cookie = session.cookies
    .filter((c) => host.endsWith(c.domain.replace(/^\./, "")))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ")
  const final = await seed({
    repo: values.repo,
    origin: values.origin,
    records: readFileSync(values.records, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    state: values.state,
    every: Number(values.every) * 1000,
    lockedEvery: Number(values["locked-every"]) * 1000,
    limit: values.limit === undefined ? undefined : Number(values.limit),
    headers: { cookie, origin: values.origin, "x-smithers-device-person": person, "content-type": "application/json" },
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    locked: () => existsSync(`${dir}/run.lock`),
    log: (line) => console.log(JSON.stringify(line)),
  })
  if (final.event !== "done") process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
