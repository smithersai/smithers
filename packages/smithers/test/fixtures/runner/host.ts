/**
 * The host side of the runner protocol for the runner's tests: a real HTTP
 * server on loopback that keeps its jobs in memory and answers claim,
 * heartbeat, settle and transcript events as `AgentRunner` and `Transcript` specify, so the runner under test
 * speaks to a peer over the wire. The app's own routes and job store are
 * tested against Postgres in apps/mvp; this is the runner's peer, not theirs.
 */
import * as AgentRunner from "@smthrs/agent/AgentRunner"
import type * as Transcript from "@smthrs/agent/Transcript"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { join } from "node:path"

/** One job the host holds, as its store would: its state, claim, flags and outcome. */
export interface Row {
  readonly key: string
  readonly generation: number
  readonly task: AgentRunner.Task
  readonly deadline: number
  state: "queued" | "claimed" | "settled"
  claim?: string
  claims: number
  cancel: boolean
  held: boolean
  heartbeats: number
  /** Every heartbeat's body, in order. */
  readonly beats: Array<typeof AgentRunner.HeartbeatRequest.Type>
  outcome?: AgentRunner.Outcome
  /** The job's transcript events, by seq, each kept once. */
  readonly events: Map<number, Transcript.Event>
  /** When the host first stored each seq, in epoch ms. */
  readonly received: Map<number, number>
  /** When the job was claimed, in epoch ms. */
  claimedAt?: number
  /** The token that claimed it. */
  claimToken?: string
  /** Events requests: how many were answered, and how many were refused while events were blocked. */
  posts: number
  refusedPosts: number
  /** The messages for the agent the host hands out at each heartbeat, until the runner says the agent read them. */
  steers: Array<AgentRunner.Steer>
  /** Every id the runner said the agent read, in the order it said so, repeats included. */
  delivered: Array<string>
  /** Whether a delivered steer stops being handed out; `false` keeps handing it out, as a host that lost the record. */
  promote: boolean
  /** Whether a heartbeat's `delivered` is recorded; `false` records only the settlement's, as answers lost would. */
  heartbeatAcks: boolean
}

/** The job's events in seq order, and whether their seqs run from 0 with no gap. */
export const transcriptOf = (row: Row) => {
  const events = [...row.events.values()].sort((a, b) => a.seq - b.seq)
  return { events, contiguous: events.every((event, n) => event.seq === n) }
}

const read = (request: IncomingMessage) =>
  new Promise<string>((done) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => (body += chunk))
    request.on("end", () => done(body))
  })

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

/** Starts the host on a loopback port, accepting `token` as the runner's bearer. */
export const start = async (token: string) => {
  /** The token the host takes: `rotate` replaces it, as an Admin registering the runner again with a new one. */
  const accepted = { token }
  const rows = new Map<string, Row>()
  // Until when the events route answers 503, as a host that can't be reached.
  let blockedUntil = 0
  /** Every claim's machine facts, in order. */
  const machines: Array<AgentRunner.Machine | undefined> = []
  /** Every claim request, in order. */
  const claimRequests: Array<typeof AgentRunner.ClaimRequest.Type> = []
  /**
   * How the git-credential route answers (decision 0148): each of `sequence` in turn, then `status` (`404` unless a
   * test sets another) with `retryAfter`; its asks.
   */
  const credential = {
    status: 404,
    retryAfter: undefined as number | undefined,
    asks: 0,
    sequence: [] as Array<
      { readonly status: number; readonly retryAfter?: number; readonly issue?: Record<string, unknown> }
    >
  }
  /** The claim route's refusal while set: `403` answers as a host that no registration authorized the runner on. */
  const refusal = {
    claim: undefined as number | undefined,
    /**
     * The routes refused `403 not_authorized`, as a host after migration 0093 refuses them all until the runner is
     * registered again.
     */
    notAuthorized: new Set<"claim" | "heartbeat" | "settle" | "events" | "gitCredential">(),
    /** The status those routes are refused with: `403` unless a test sets `401`. */
    status: 403,
    /** How many heartbeats, settlements and events requests were refused so. */
    refused: { heartbeat: 0, settle: 0, events: 0 }
  }
  /**
   * How long the claim route holds its answer after it marked a job claimed (a runner may die before it hears it),
   * and how long the settle route holds its answer.
   */
  const hold = { claimMs: 0, settleMs: 0 }
  const server = createServer(async (request, response) => {
    const body = await read(request)
    if (request.headers.authorization !== `Bearer ${accepted.token}`) {
      // As the host does: a token rotated since it claimed a job still hears a Stop on that job's heartbeat, and the
      // host ends the job; nothing else.
      const asked = JSON.parse(body || "{}") as Record<string, unknown>
      const past = request.url === AgentRunner.ROUTES.heartbeat ? rows.get(String(asked.key)) : undefined
      if (
        past !== undefined && past.claim === asked.claim && past.claimToken !== undefined &&
        request.headers.authorization === `Bearer ${past.claimToken}` && past.cancel &&
        (past.state === "claimed" || past.outcome?._tag === "Cancelled")
      ) {
        past.state = "settled"
        past.outcome = { _tag: "Cancelled", processTreeGone: false }
        return json(response, 401, { code: "authentication", cancel: true })
      }
      return json(response, 401, { code: "authentication" })
    }
    const value = JSON.parse(body) as Record<string, unknown>
    for (const route of refusal.notAuthorized) {
      if (request.url !== AgentRunner.ROUTES[route]) continue
      if (route === "heartbeat" || route === "settle" || route === "events") refusal.refused[route]++
      // As the host does: a runner it no longer takes hears of a Stop on its own claim, and the host ends that job.
      const stopping = rows.get(String((JSON.parse(body) as Record<string, unknown>).key))
      if (
        route === "heartbeat" && refusal.status === 403 && stopping !== undefined && stopping.state === "claimed" &&
        stopping.cancel && stopping.claim === (JSON.parse(body) as Record<string, unknown>).claim
      ) {
        stopping.state = "settled"
        stopping.outcome = { _tag: "Cancelled", processTreeGone: false }
        return json(response, 403, { code: "not_authorized", cancel: true })
      }
      return json(response, refusal.status, { code: refusal.status === 401 ? "authentication" : "not_authorized" })
    }
    if (request.url === AgentRunner.ROUTES.claim) {
      if (refusal.claim !== undefined) return json(response, refusal.claim, { code: "not_authorized" })
      const wants = value as unknown as typeof AgentRunner.ClaimRequest.Type
      machines.push(wants.machine)
      claimRequests.push(wants)
      const asJob = (row: Row, reclaimed: boolean): AgentRunner.Job => ({
        key: row.key,
        claim: row.claim!,
        generation: row.generation,
        task: row.task,
        deadline: row.deadline,
        leaseSeconds: 45,
        reclaimed
      })
      // As the host does in the claim's own transaction: a claimed job past its deadline and the grace to settle it
      // (`SETTLE_GRACE_SECONDS`) ends `timeout`, and is never handed back.
      for (const row of rows.values()) {
        if (row.state === "claimed" && row.deadline + 300_000 <= Date.now()) {
          row.state = "settled"
          row.outcome = { _tag: "Failed", reason: "timeout" }
        }
      }
      const held = [...rows.values()].find((row) =>
        row.state === "claimed" && row.held && !wants.running.includes(row.key)
      )
      if (held !== undefined) return json(response, 200, { job: asJob(held, true) })
      const queued = [...rows.values()].find((row) =>
        row.state === "queued" && wants.free > 0 && wants.profiles.includes(row.task.agent.profile)
      )
      if (queued === undefined) return json(response, 200, { job: null })
      queued.state = "claimed"
      queued.claim = randomUUID()
      queued.claims++
      queued.claimedAt = Date.now()
      queued.claimToken = accepted.token
      if (hold.claimMs > 0) await new Promise((done) => setTimeout(done, hold.claimMs))
      return json(response, 200, { job: asJob(queued, false) })
    }
    const row = rows.get(String(value.key))
    const holds = row !== undefined && row.state === "claimed" && row.claim === value.claim && row.held
    if (request.url === AgentRunner.ROUTES.gitCredential) {
      credential.asks++
      const answer: {
        readonly status: number
        readonly retryAfter?: number
        readonly issue?: Record<string, unknown>
      } = credential.sequence.shift() ??
        {
          status: credential.status,
          ...(credential.retryAfter === undefined ? {} : { retryAfter: credential.retryAfter })
        }
      if (answer.issue !== undefined) return json(response, 200, answer.issue)
      if (answer.retryAfter !== undefined) response.setHeader("retry-after", String(answer.retryAfter))
      return json(response, answer.status, { code: answer.status === 404 ? "not_found" : "refused" })
    }
    if (request.url === AgentRunner.ROUTES.heartbeat) {
      if (row !== undefined) {
        row.heartbeats++
        row.beats.push(value as unknown as typeof AgentRunner.HeartbeatRequest.Type)
      }
      if (!holds) return json(response, 200, { held: false, cancel: false, leaseSeconds: 45 })
      const delivered = row.heartbeatAcks ? (value.delivered ?? []) as ReadonlyArray<string> : []
      row.delivered.push(...delivered)
      if (row.promote) row.steers = row.steers.filter((steer) => !delivered.includes(steer.id))
      return json(response, 200, {
        held: true,
        cancel: row.cancel,
        leaseSeconds: 45,
        ...(row.steers.length === 0 ? {} : { steers: row.steers })
      })
    }
    if (request.url === AgentRunner.ROUTES.events) {
      // The runner that held the claim may send its events after it settled.
      if (row === undefined || row.claim !== value.claim) return json(response, 409, { code: "not_held" })
      if (Date.now() < blockedUntil) {
        row.refusedPosts++
        return json(response, 503, { code: "unavailable" })
      }
      row.posts++
      for (const event of value.events as ReadonlyArray<Transcript.Event>) {
        if (!row.events.has(event.seq)) {
          row.events.set(event.seq, event)
          row.received.set(event.seq, Date.now())
        }
      }
      let next = 0
      while (row.events.has(next)) next++
      return json(response, 200, { next })
    }
    if (request.url === AgentRunner.ROUTES.settle) {
      if (hold.settleMs > 0) await new Promise((done) => setTimeout(done, hold.settleMs))
      if (!holds) return json(response, 200, { recorded: false })
      row.delivered.push(...((value.delivered ?? []) as ReadonlyArray<string>))
      row.state = "settled"
      row.outcome = value.outcome as AgentRunner.Outcome
      return json(response, 200, { recorded: true })
    }
    json(response, 404, { code: "not_found" })
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  const origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`
  return {
    origin,
    rows,
    machines,
    claimRequests,
    credential,
    refusal,
    hold,
    /** Takes `token` from now on, and refuses the one before `401`. */
    rotate: (token: string) => void (accepted.token = token),
    /** Queues generation `generation` of the step `origin` with `task`. */
    enqueue: (
      task: AgentRunner.Task,
      options: { readonly origin?: string; readonly generation?: number; readonly deadline?: number } = {}
    ) => {
      const generation = options.generation ?? 1
      const key = `${options.origin ?? randomUUID()}#g${generation}`
      const row: Row = {
        key,
        generation,
        task,
        deadline: options.deadline ?? Date.now() + 10 * 60_000,
        state: "queued",
        claims: 0,
        cancel: false,
        held: true,
        heartbeats: 0,
        events: new Map(),
        received: new Map(),
        posts: 0,
        refusedPosts: 0,
        steers: [],
        delivered: [],
        promote: true,
        heartbeatAcks: true,
        beats: []
      }
      rows.set(key, row)
      return row
    },
    /** Waits until `row` is settled, for at most `timeoutMs`. */
    settled: async (row: Row, timeoutMs = 60_000) => {
      const until = Date.now() + timeoutMs
      while (row.state !== "settled") {
        if (Date.now() > until) throw new Error(`job ${row.key} was not settled within ${timeoutMs} ms`)
        await new Promise((done) => setTimeout(done, 50))
      }
      return row.outcome!
    },
    /** Answers every events request 503 for the next `ms` milliseconds. */
    blockEvents: (ms: number) => {
      blockedUntil = Date.now() + ms
    },
    /** Waits until `row`'s transcript holds the session's end, for at most `timeoutMs`. */
    transcribed: async (row: Row, timeoutMs = 60_000) => {
      const until = Date.now() + timeoutMs
      while (![...row.events.values()].some((event) => event.kind === "_smithers/end")) {
        if (Date.now() > until) throw new Error(`job ${row.key}'s transcript did not end within ${timeoutMs} ms`)
        await new Promise((done) => setTimeout(done, 50))
      }
      return transcriptOf(row)
    },
    close: () => new Promise<void>((done) => server.close(() => done()))
  }
}

/** The jj flags every fixture call passes: no user configuration, a fixed identity. */
export const jjFlags = [
  "--no-pager",
  "--color=never",
  "--config",
  "user.name=fixture",
  "--config",
  "user.email=fixture@localhost"
]

/** A local jj repository with one commit holding README.md: its path and the commit's id. */
export const mirror = (root: string) => {
  const path = join(root, "mirror")
  const env = { ...process.env, JJ_CONFIG: join(root, "jj-config") }
  mkdirSync(env.JJ_CONFIG, { recursive: true })
  execFileSync("jj", ["git", "init", path, ...jjFlags], { env, stdio: "ignore" })
  writeFileSync(join(path, "README.md"), "hello\n")
  execFileSync("jj", ["-R", path, "commit", "-m", "base", ...jjFlags], { env, stdio: "ignore" })
  const base = execFileSync("jj", ["-R", path, "log", "--no-graph", "-r", "@-", "-T", "commit_id", ...jjFlags], {
    env,
    encoding: "utf8"
  }).trim()
  return { path, base }
}

/** A task for `profile` on `repository` at `base` whose prompt is `prompt`. */
export const task = (options: {
  readonly profile?: string
  readonly repository?: string
  readonly base: string
  readonly prompt: string
  readonly limits?: AgentRunner.Limits
}): AgentRunner.Task => ({
  agent: { name: "tester", labels: ["linux"], profile: options.profile ?? "test-agent", maxHours: 1, restarts: 1 },
  repository: options.repository ?? "github/acme/app",
  base: options.base,
  system: ["You are a test."],
  prompt: options.prompt,
  limits: options.limits ?? { files: 50, bytes: 1024 * 1024 }
})
