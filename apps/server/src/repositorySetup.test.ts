import { afterEach, expect, test } from "bun:test"
import { initialSetup, setupCandidate } from "@smthrs/rpc/RepositorySetup"
import worker from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const frame = (value: unknown) => new Response(`${JSON.stringify({ _tag: "Exit", requestId: 1, exit: { _tag: "Success", value } })}\n`)
const gate = () => { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve }); return { wait, release } }
async function fixture() {
  const settings = { ASSETS: { fetch: async () => new Response("SPA") }, IDENTITY_UPSTREAM_URL: "https://identity.test", IDENTITY_SERVICE_TOKEN: "synthetic-service", SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test" }
  const durable = memoryDurableObjects({ env: settings, nativeAlarms: true })
  const env = { ...settings, GATEWAY_SESSIONS: durable.GATEWAY_SESSIONS, TURN_CANCELS: durable.TURN_CANCELS }
  const workspaceIds = { alice: "11111111-1111-4111-8111-111111111111", bob: "22222222-2222-4222-8222-222222222222" }
  for (const login of ["alice", "bob"] as const) await durable.seedGatewayRecord(login, "org/repo", { gatewayId: `gateway-${login}`, baseUrl: `https://gateway.test/${login}`, token: `synthetic-${login}`, vmId: null, workspaceId: workspaceIds[login],
    expiresAt: Date.now() + 3_600_000, renewAfter: Date.now() + 1_800_000, provisionedAt: Date.now() })
  const setup = initialSetup("org/repo", "issues", "alice")
  const input = { requestId: "setup-test", repo: setup.repo, job: setup.job, revision: setup.revision, draft: setup.draft, digest: setupCandidate(setup) }
  const background: Promise<unknown>[] = []
  const calls: Array<{ login: string; tag: string; payload: Record<string, unknown> }> = []
  const options: { beforePlan?: Promise<void>; beforeWorkspace?: Promise<void>; workspaceState: string; runState: string; readError?: boolean; wrongFlow?: boolean; wrongResult?: boolean; incompatibleHost?: boolean;
    sleepBefore?: string; rejectResumedHost?: boolean;
    workspaceRefusal?: { status: number; code: string; message: string } } = { runState: "running", workspaceState: "running" }
  const workspaceCalls: Array<{ method: string; path: string; body?: unknown }> = []
  const capabilityCalls: unknown[] = []
  const plans = new Map<string, Record<string, unknown>>()
  const launched = new Set<string>()
  globalThis.fetch = (async (target: RequestInfo | URL, init?: RequestInit) => {
    const request = target instanceof Request ? target : new Request(String(target), init)
    const url = new URL(request.url)
    if (url.hostname === "identity.test") {
      if (url.pathname === "/api/identity/cloud-token") return Response.json({ found: true, token: `cloud-${(await request.json() as { login: string }).login}` })
      const login = request.headers.get("cookie")?.split("=")[1]
      return !login || login === "expired" ? Response.json({}, { status: 401 }) : Response.json({ login, allowlisted: login !== "visitor", admin: false })
    }
    if (url.hostname === "cloud.test") {
      if (options.beforeWorkspace) await options.beforeWorkspace
      const login = request.headers.get("authorization")?.replace("Bearer cloud-", "") as keyof typeof workspaceIds
      expect(workspaceIds[login]).toBeDefined()
      if (url.pathname.endsWith("/gateway")) {
        const body = await request.json()
        capabilityCalls.push(body)
        expect(body).toEqual({ workspace_id: workspaceIds[login], required_capability: "repository-jobs/v1" })
        if (options.incompatibleHost) return Response.json({ code: "coding_host_upgrade_required", message: "This workspace needs a compatible coding host." }, { status: 409 })
        return Response.json({ gateway_id: `gateway-${login}`, workspace_id: workspaceIds[login], base_url: `https://gateway.test/${login}`,
          token: `synthetic-${login}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() })
      }
      workspaceCalls.push({ method: request.method, path: url.pathname, ...(request.method === "POST" ? { body: await request.json() } : {}) })
      if (options.workspaceRefusal) return Response.json(options.workspaceRefusal, { status: options.workspaceRefusal.status })
      return Response.json({ id: workspaceIds[login], status: options.workspaceState, kind: "vm", repo_full_name: "org/repo" })
    }
    if (url.hostname !== "gateway.test") throw Error("Unexpected upstream")
    const login = url.pathname.split("/")[1]!
    expect(request.headers.get("authorization")).toBe(`Bearer synthetic-${login}`)
    const body = JSON.parse(await request.text()) as { tag: string; payload: Record<string, unknown> }
    calls.push({ login, ...body })
    if (options.sleepBefore === body.tag) {
      options.sleepBefore = undefined
      options.incompatibleHost = options.rejectResumedHost
      return Response.json({ code: "conflict", message: "bound workspace is not running at the recorded VM" }, { status: 409 })
    }
    const id = `${login}:${input.requestId}`
    if (body.tag === "Plan") {
      if (options.beforePlan) await options.beforePlan
      if (!plans.has(id)) plans.set(id, { planId: `plan-${id}`, flowId: options.wrongFlow ? "unrelated/flow" : "repository/setup", digest: "d".repeat(64), executionDigest: "e".repeat(64),
        envelope: { capabilities: ["repository:read"], flows: ["repository/RunSetup"], budget: { tokens: 120000, milliseconds: 600000 } } })
      return frame(plans.get(id))
    }
    if (body.tag === "Approval.Submit") return frame({ approved: true })
    if (body.tag === "Run") { launched.add(`${login}:${String(body.payload.idempotencyKey)}`); return frame({ runId: `run-${id}` }) }
    if (body.tag !== "Projection.Snapshot") throw Error("Unexpected RPC")
    if (options.readError) throw Error("Observation disconnected")
    const operation = (calls.find(call => call.login === login && call.tag === "Plan")!.payload.input as { operation: string }).operation
    const receipt = { requestId: options.wrongResult ? "different-request" : input.requestId, runId: `run-${id}`, revision: input.revision, digest: input.digest,
      operation, phase: "completed", updatedAt: Date.now(), results: [], evidence: ["actual-host-artifact"],
      ...(operation === "run" ? { jobRunId: "actual-manual-job" } : {}) }
    return frame({ selector: body.payload.selector, rows: [{ runId: `run-${id}`, flowId: "repository/setup", status: options.runState, updatedAt: Date.now(), verdict: "Run failed",
      ...(options.runState === "completed" ? { finalOutput: JSON.stringify({ requestId: receipt.requestId, revision: input.revision, digest: input.digest, receipt }) } : {}) }] })
  }) as typeof fetch
  const send = (method: string, suffix: string, login = "alice", body?: unknown) => worker.fetch(new Request(`https://app.test/api/repository-setup/${suffix}`, {
    method, headers: { "content-type": "application/json", ...(login ? { cookie: `session=${login}` } : {}), "x-user-login": "forged" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }), env, { waitUntil: promise => { background.push(promise) } })
  const settle = async () => { for (let index = 0; index < background.length; index++) await background[index] }
  const read = (login = "alice") => send("GET", `request?requestId=${input.requestId}&repo=org%2Frepo&job=issues`, login)
  return { durable, env, input, calls, options, launched, plans, background, send, read, settle, workspaceCalls, workspaceIds, capabilityCalls }
}

test("fresh setup acknowledges while workspace creation is unresolved, pins the compatible VM and resumes after reload", async () => {
  const t = await fixture(), held = gate()
  t.options.beforeWorkspace = held.wait; t.options.workspaceState = "starting"
  try {
    const response = await Promise.race([t.send("POST", "evaluate", "alice", t.input), new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 150))])
    expect(response?.status).toBe(202)
    expect(t.calls).toHaveLength(0)
    held.release(); await t.settle()
    expect(t.workspaceCalls).toEqual([{ method: "POST", path: "/api/repos/org/repo/workspaces", body: { kind: "vm", name: "Repository", required_capability: "repository-jobs/v1" } }])
    t.durable.restart()
    t.options.workspaceState = "running"
    const saved = await (await t.read()).json() as { workspaceId: string; receipt: { runId?: string; phase: string } }
    expect(saved.workspaceId).toBe(t.workspaceIds.alice)
    expect(saved.receipt.runId).toBeUndefined()
    expect(saved.receipt.phase).toBe("queued")
    await t.settle()
    expect(t.workspaceCalls[1]).toEqual({ method: "GET", path: `/api/repos/org/repo/workspaces/${t.workspaceIds.alice}` })
    expect(t.workspaceCalls.filter(call => call.method === "POST")).toHaveLength(1)
    expect((t.calls.find(call => call.tag === "Plan")!.payload.input as { workspaceId: string }).workspaceId).toBe(t.workspaceIds.alice)
    expect(t.launched.size).toBe(1)
    expect(t.capabilityCalls).toHaveLength(1)
  } finally { held.release(); await t.settle() }
})

test("a cold unverified primary stays queued across reload without pinning or launching", async () => {
  const t = await fixture()
  t.options.workspaceRefusal = { status: 409, code: "repository_workspace_pending", message: "The repository workspace is starting" }
  expect((await t.send("POST", "evaluate", "alice", t.input)).status).toBe(202)
  await t.settle()
  t.durable.restart()
  await t.durable.runGatewayAlarms()
  const waiting = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as {
    workspaceId?: string; binding?: unknown; observationError?: string; receipt: { phase: string }
  }
  expect(waiting.workspaceId).toBeUndefined()
  expect(waiting.binding).toBeUndefined()
  expect(waiting.observationError).toBeUndefined()
  expect(waiting.receipt.phase).toBe("queued")
  expect(t.capabilityCalls).toHaveLength(0)
  expect(t.launched.size).toBe(0)
  expect(t.workspaceCalls.length).toBeGreaterThanOrEqual(2)
  expect(t.workspaceCalls.every(call => call.method === "POST")).toBe(true)
  t.options.workspaceRefusal = undefined
  await t.durable.runGatewayAlarms()
  const selected = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as { workspaceId: string }
  expect(selected.workspaceId).toBe(t.workspaceIds.alice)
  expect(t.launched.size).toBe(1)
  expect((t.calls.find(call => call.tag === "Plan")!.payload.input as { workspaceId: string }).workspaceId).toBe(t.workspaceIds.alice)
})

test("only typed pending clears a previous selection error; generic conflicts remain visible", async () => {
  const t = await fixture()
  t.options.workspaceRefusal = { status: 409, code: "conflict", message: "The workspace identity changed" }
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  let stored = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as { observationError?: string; workspaceId?: string }
  expect(stored.observationError).toBe("The workspace identity changed")
  expect(stored.workspaceId).toBeUndefined()
  t.options.workspaceRefusal = { status: 503, code: "repository_workspace_pending", message: "Provider unavailable" }
  await t.durable.runGatewayAlarms()
  stored = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as typeof stored
  expect(stored.observationError).toBe("Provider unavailable")
  t.options.workspaceRefusal = { status: 409, code: "repository_workspace_pending", message: "The repository workspace is starting" }
  await t.durable.runGatewayAlarms()
  stored = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as typeof stored
  expect(stored.observationError).toBeUndefined()
  expect(stored.workspaceId).toBeUndefined()
  expect(t.launched.size).toBe(0)
})

test("a cached old gateway cannot admit setup before live capability proof or move the pinned workspace", async () => {
  const t = await fixture()
  t.options.incompatibleHost = true
  expect((await t.send("POST", "evaluate", "alice", { ...t.input, workspaceId: t.workspaceIds.alice })).status).toBe(202)
  await t.settle()
  expect(t.capabilityCalls).toHaveLength(1)
  expect(t.calls).toHaveLength(0)
  expect(t.launched.size).toBe(0)
  expect(t.workspaceCalls.every(call => call.method === "GET" && call.path.endsWith(t.workspaceIds.alice))).toBe(true)
  const response = await t.read()
  expect(response.status).toBe(503)
  const pending = await response.json() as { message: string }
  expect(pending.message).toContain("compatible coding host")
  const retained = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as { workspaceId: string }
  expect(retained.workspaceId).toBe(t.workspaceIds.alice)
  await t.settle()
  t.options.incompatibleHost = false
  t.durable.restart()
  await t.durable.runGatewayAlarms()
  expect(t.launched.size).toBe(1)
  expect((t.calls.find(call => call.tag === "Plan")!.payload.input as { workspaceId: string }).workspaceId).toBe(t.workspaceIds.alice)
})

test.each(["Plan", "Run", "Projection.Snapshot"])("a bound setup rechecks resumed capability before forwarding %s", async (procedure) => {
  const t = await fixture()
  t.options.sleepBefore = procedure
  t.options.rejectResumedHost = true
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  expect(t.capabilityCalls).toHaveLength(2)
  expect(t.calls.filter(call => call.tag === procedure)).toHaveLength(1)
  expect(t.launched.size).toBe(procedure === "Projection.Snapshot" ? 1 : 0)
  const stored = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as {
    binding: { workspaceId: string }; observationError?: string
  }
  expect(stored.binding.workspaceId).toBe(t.workspaceIds.alice)
  expect(stored.observationError).toContain("compatible coding host")
  const callsBeforeRestart = t.calls.length
  t.durable.restart()
  await t.durable.runGatewayAlarms()
  expect(t.calls).toHaveLength(callsBeforeRestart)
  expect(t.capabilityCalls).toHaveLength(3)
  expect(t.workspaceCalls.filter(call => call.method === "POST")).toHaveLength(1)
})

test("a sleeping setup Run is not replayed inline and a durable retry retains its original key", async () => {
  const t = await fixture()
  t.options.sleepBefore = "Run"
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  expect(t.capabilityCalls).toHaveLength(2)
  expect(t.calls.filter(call => call.tag === "Run")).toHaveLength(1)
  expect(t.launched.size).toBe(0)
  t.durable.restart()
  await t.durable.runGatewayAlarms()
  const attempts = t.calls.filter(call => call.tag === "Run")
  expect(attempts).toHaveLength(2)
  expect(attempts[1]?.payload).toEqual(attempts[0]?.payload)
  expect(t.launched.size).toBe(1)
  expect(t.workspaceCalls.filter(call => call.method === "POST")).toHaveLength(1)
})

test("a closed browser and a restarted Durable Object still launch and finish the admitted setup", async () => {
  const t = await fixture()
  t.options.workspaceState = "starting"
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  expect(t.launched.size).toBe(0)
  expect(t.durable.pendingGatewayAlarms()).toEqual(["alice"])
  t.durable.restart()
  t.options.workspaceState = "running"
  await t.durable.runGatewayAlarms()
  expect(t.launched.size).toBe(1)
  t.options.runState = "completed"
  t.durable.restart()
  await t.durable.runGatewayAlarms()
  const stored = t.durable.gatewayRows("alice").get(`repository-setup:request:${t.input.requestId}`) as { receipt: { phase: string }; result: unknown }
  expect(stored.receipt.phase).toBe("completed")
  expect(stored.result).toBeDefined()
  await t.durable.runGatewayAlarms()
  expect(t.durable.pendingGatewayAlarms()).toEqual([])
  expect(t.launched.size).toBe(1)
})

test("retry can echo the server-pinned workspace but cannot move an admitted request", async () => {
  const t = await fixture()
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  t.durable.restart()
  expect((await t.send("POST", "evaluate", "alice", { ...t.input, workspaceId: t.workspaceIds.alice })).status).toBe(202)
  await t.settle()
  expect((await t.send("POST", "evaluate", "alice", { ...t.input, workspaceId: t.workspaceIds.bob })).status).toBe(409)
  expect(t.launched.size).toBe(1)
})

test("manual work survives restart and retries only its original subject and prompt", async () => {
  const t = await fixture()
  const manual = { stepId: "poc", prompt: "Try the reported fix", subject: { source: "smithers-cloud", kind: "issue", number: 12 } }
  expect((await t.send("POST", "run", "alice", { ...t.input, manual })).status).toBe(202)
  await t.settle(); t.durable.restart()
  expect((await t.send("POST", "run", "alice", { ...t.input, manual })).status).toBe(202)
  await t.settle()
  expect((await t.send("POST", "run", "alice", { ...t.input, manual: { ...manual, prompt: "Do different work" } })).status).toBe(409)
  expect((await t.send("POST", "run", "alice", { ...t.input, manual: { ...manual, subject: { ...manual.subject, number: 13 } } })).status).toBe(409)
  expect(t.launched.size).toBe(1)
  expect((t.calls.find(call => call.tag === "Plan")!.payload.input as { manual: unknown }).manual).toEqual(manual)
  t.options.runState = "completed"
  await t.durable.runGatewayAlarms()
  const response = await t.read()
  expect(response.status).toBe(200)
  expect((await response.json() as { receipt: { jobRunId: string } }).receipt.jobRunId).toBe("actual-manual-job")
})

test("setup persists and acknowledges before Plan answers, and duplicate launches share engine keys", async () => {
  const t = await fixture(), held = gate()
  t.options.beforePlan = held.wait
  try {
    const first = await Promise.race([t.send("POST", "evaluate", "alice", t.input), new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 150))])
    expect(first?.status).toBe(202)
    const accepted = await first!.json() as { receipt: { phase: string; runId?: string } }
    expect(accepted.receipt.phase).toBe("queued")
    expect(accepted.receipt.runId).toBeUndefined()
    expect(t.launched.size).toBe(0)
    expect((await t.send("POST", "evaluate", "alice", t.input)).status).toBe(202)
    held.release(); await t.settle()
    expect(t.plans.size).toBe(1)
    expect(t.launched.size).toBe(1)
    const observed = await (await t.read()).json() as { receipt: { phase: string; runId: string } }
    expect(observed.receipt.phase).toBe("running")
    expect(observed.receipt.runId).toBe("run-alice:setup-test")
    await t.settle()
  } finally { held.release(); await t.settle() }
})

test("setup authority is session-derived and no gateway credential reaches the response", async () => {
  const t = await fixture()
  for (const login of ["", "expired", "visitor"]) {
    const result = await t.send("POST", "evaluate", login, { ...t.input, login: "alice" })
    expect(result.status).toBe(login === "visitor" ? 403 : 401)
  }
  expect(t.calls).toHaveLength(0)
  for (const login of ["alice", "bob"]) {
    const result = await t.send("POST", "evaluate", login, { ...t.input, login: "forged", evaluation: { passed: true }, active: true })
    expect(result.status).toBe(202)
    expect(await result.text()).not.toContain("synthetic-")
    await t.settle()
  }
  expect(t.launched.size).toBe(2)
  const planInputs = t.calls.filter(call => call.tag === "Plan").map(call => call.payload.input as Record<string, unknown>)
  expect(planInputs.every(input => !Object.hasOwn(input, "login") && !Object.hasOwn(input, "evaluation") && !Object.hasOwn(input, "active"))).toBe(true)
})

test("the same request id cannot be reused for a different candidate or operation", async () => {
  const t = await fixture()
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  expect((await t.send("POST", "trial", "alice", t.input)).status).toBe(409)
  expect(t.launched.size).toBe(1)
  const changed = { ...t.input, revision: 2 }
  changed.digest = setupCandidate(changed)
  expect((await t.send("POST", "evaluate", "alice", changed)).status).toBe(409)
})

test("an incorrect digest is rejected before storage or model work", async () => {
  const t = await fixture()
  expect((await t.send("POST", "evaluate", "alice", { ...t.input, digest: "f".repeat(64) })).status).toBe(400)
  expect(t.calls).toHaveLength(0)
  expect((await t.read()).status).toBe(404)
})

test("completion comes from actual host output and is retained without rerunning", async () => {
  const t = await fixture()
  t.options.runState = "completed"
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  const result = await t.read()
  expect(result.status).toBe(200)
  expect((await result.json() as { receipt: { phase: string } }).receipt.phase).toBe("completed")
  const calls = t.calls.length
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  expect(t.calls.length).toBe(calls)
})

test("native accepted and approval or signal waits retain a live setup receipt", async () => {
  for (const [status, phase] of [["accepted", "queued"], ["waiting-approval", "waiting"], ["parked", "waiting"]]) {
    const t = await fixture()
    t.options.runState = status!
    await t.send("POST", "evaluate", "alice", t.input); await t.settle()
    const response = await t.read()
    expect(response.status).toBe(202)
    expect((await response.json() as { receipt: { phase: string } }).receipt.phase).toBe(phase!)
    await t.settle()
    expect(t.launched.size).toBe(1)
  }
})

test("observation loss preserves running state and reconnects the original run", async () => {
  const t = await fixture()
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  t.options.readError = true
  await t.read(); await t.settle()
  expect((await t.read()).status).toBe(503); await t.settle()
  t.options.readError = false; t.options.runState = "completed"
  const retry = await t.send("POST", "evaluate", "alice", t.input)
  expect((await retry.json() as { receipt: { phase: string } }).receipt.phase).toBe("running")
  await t.settle()
  expect(t.launched.size).toBe(1)
  expect((await t.read()).status).toBe(200)
})

test("a different flow's plan is never approved and mismatched final receipts never become success", async () => {
  const t = await fixture()
  t.options.wrongFlow = true
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  expect(t.calls.some(call => call.tag === "Approval.Submit")).toBe(false)
  expect((await t.read()).status).toBe(503); await t.settle()
})

test("a mismatched completed result leaves the original candidate unverified", async () => {
  const t = await fixture()
  t.options.wrongResult = true; t.options.runState = "completed"
  await t.send("POST", "evaluate", "alice", t.input); await t.settle()
  expect((await t.read()).status).toBe(503); await t.settle()
  expect(t.launched.size).toBe(1)
})
