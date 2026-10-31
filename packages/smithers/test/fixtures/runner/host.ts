/**
 * The host side of the runner protocol for the runner's tests: a real HTTP
 * server on loopback that keeps its jobs in memory and answers claim,
 * heartbeat and settle as `AgentRunner` specifies, so the runner under test
 * speaks to a peer over the wire. The app's own routes and job store are
 * tested against Postgres in apps/mvp; this is the runner's peer, not theirs.
 */
import * as AgentRunner from "@smthrs/agent/AgentRunner"
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
  const rows = new Map<string, Row>()
  /** Every claim's machine facts, in order. */
  const machines: Array<AgentRunner.Machine | undefined> = []
  const server = createServer(async (request, response) => {
    const body = await read(request)
    if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { code: "authentication" })
    const value = JSON.parse(body) as Record<string, unknown>
    if (request.url === AgentRunner.ROUTES.claim) {
      const wants = value as unknown as typeof AgentRunner.ClaimRequest.Type
      machines.push(wants.machine)
      const asJob = (row: Row, reclaimed: boolean): AgentRunner.Job => ({
        key: row.key,
        claim: row.claim!,
        generation: row.generation,
        task: row.task,
        deadline: row.deadline,
        leaseSeconds: 45,
        reclaimed
      })
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
      return json(response, 200, { job: asJob(queued, false) })
    }
    const row = rows.get(String(value.key))
    const holds = row !== undefined && row.state === "claimed" && row.claim === value.claim && row.held
    if (request.url === AgentRunner.ROUTES.heartbeat) {
      if (row !== undefined) {
        row.heartbeats++
        row.beats.push(value as unknown as typeof AgentRunner.HeartbeatRequest.Type)
      }
      return json(response, 200, { held: holds, cancel: holds && row.cancel, leaseSeconds: 45 })
    }
    if (request.url === AgentRunner.ROUTES.settle) {
      if (!holds) return json(response, 200, { recorded: false })
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
    close: () => new Promise<void>((done) => server.close(() => done()))
  }
}

/** The jj flags every fixture call passes: no user configuration, a fixed identity. */
const jjFlags = [
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
