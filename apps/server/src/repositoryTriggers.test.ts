import { afterEach, expect, test } from "bun:test"
import { initialSetup, REPOSITORY_JOBS, setupCandidate, type RepositoryJob, type SetupRecoveryResponse } from "@smthrs/rpc/RepositorySetup"
import worker from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"
import { TRIGGER_APPROVAL_PATH, TRIGGER_PAUSE_PATH, TRIGGER_REGISTRATIONS_PATH, triggerRegistrationRow } from "./repositoryTriggers"

/*
 * The three generic-trigger routes (L36 §1.5) through the real Worker: the
 * listing that parses each row on its own, the pause that stops a schedule,
 * and the approval receipt Plue stamps. Nothing here reaches a network: the
 * identity door and Smithers Cloud are both the stub below, and an
 * unstubbed host throws rather than resolving.
 */

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const workspaceId = "11111111-1111-4111-8111-111111111111"

/** One of the five built-in setup registrations, exactly as recovery reads it. */
const known = (job: RepositoryJob, mode: "enabled" | "trial") => {
  const source = initialSetup("org/repo", job, "alice")
  const shared = { repo: source.repo, workspace_id: workspaceId, source_revision: "b".repeat(40), flow_id: `repository-jobs/${job}`,
    mode, revision: source.revision, digest: setupCandidate(source), schedule: "" }
  return { ...shared, id: `registration-${job}-${mode}`, user_id: 1, job, enabled: true, next_fire_at: null, configuration: { ...shared, input: source.draft } }
}

/** A generic trigger row as Plue serves it. */
const triggerRow = (slug: string, overrides: Record<string, unknown> = {}) => ({
  id: `registration-${slug}`, workspace_id: workspaceId, user_id: 1, job: `flow:${slug}`, mode: "enabled",
  revision: 1, digest: "c".repeat(64), source_revision: "b".repeat(40), flow_id: "nightly-lint", enabled: true,
  schedule: "0 9 * * 1-5", next_fire_at: "2026-09-18T09:00:00Z",
  configuration: { input: { label: "nightly" } }, ...overrides
})

interface CloudCall { readonly method: string; readonly path: string; readonly body: string | null }

/** The Worker under a stubbed identity door and a stubbed Smithers Cloud. */
const deployment = (cloud: (call: CloudCall) => Response) => {
  const settings = { ASSETS: { fetch: async () => new Response("SPA") }, IDENTITY_UPSTREAM_URL: "https://identity.test",
    IDENTITY_SERVICE_TOKEN: "synthetic-service", SMITHERS_CLOUD_API_BASE_URL: "https://cloud.test" }
  const durable = memoryDurableObjects({ env: settings, nativeAlarms: true })
  const env = { ...settings, GATEWAY_SESSIONS: durable.GATEWAY_SESSIONS, TURN_CANCELS: durable.TURN_CANCELS }
  const calls: Array<CloudCall> = []
  globalThis.fetch = (async (target: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(target instanceof Request ? target.url : String(target), "https://identity.test")
    if (url.hostname === "identity.test") {
      if (url.pathname === "/api/identity/cloud-token") return Response.json({ found: true, token: "cloud-alice" })
      const cookie = (target instanceof Request ? target.headers.get("cookie") : null) ??
        new Headers(init?.headers ?? {}).get("cookie")
      return cookie === null || cookie === ""
        ? Response.json({ error: "no session" }, { status: 401 })
        : Response.json({ login: "alice", allowlisted: true, admin: false })
    }
    if (url.hostname !== "cloud.test") throw Error(`Unexpected upstream ${url.toString()}`)
    const call: CloudCall = {
      method: (target instanceof Request ? target.method : init?.method) ?? "GET",
      path: url.pathname,
      body: typeof init?.body === "string" ? init.body : null
    }
    calls.push(call)
    return cloud(call)
  }) as typeof fetch
  const background: Array<Promise<unknown>> = []
  const fetchAs = (path: string, init?: RequestInit & { readonly signedIn?: boolean }) =>
    worker.fetch(
      new Request(`https://app.test${path}`, { ...init, headers: { ...(init?.signedIn === false ? {} : { cookie: "session=alice" }), ...(init?.headers ?? {}) } }),
      env,
      { waitUntil: (promise: Promise<unknown>) => { background.push(promise) } }
    )
  return { calls, fetchAs }
}

const body = async (response: Response) => await response.json() as Record<string, unknown>

test("the listing reads each row on its own: the five built-ins, a foreign row and a later shape never hide a trigger", async () => {
  const rows = [
    ...REPOSITORY_JOBS.map((job) => known(job, "enabled")),
    triggerRow("nightly"),
    { id: "from-the-future", job: "flow:tomorrow", flow_id: "x", schedule: "0 3 * * *", enabled: true, revision: "one" },
    { nothing: "recognisable" }
  ]
  const { fetchAs } = deployment(() => Response.json(rows))
  const answer = await fetchAs(`${TRIGGER_REGISTRATIONS_PATH}?repo=org%2Frepo`)
  expect(answer.status).toBe(200)
  expect(await body(answer)).toEqual({
    status: "ok",
    repo: "org/repo",
    rows: [{
      slug: "nightly", flowId: "nightly-lint", schedule: "0 9 * * 1-5", enabled: true, revision: 1,
      digest: "c".repeat(64), sourceRevision: "b".repeat(40), nextFireAt: "2026-09-18T09:00:00Z",
      registrationId: "registration-nightly"
    }]
  })
})

test("a trigger row leaves the five setup jobs' recovery reporting their real state", async () => {
  const rows = [...REPOSITORY_JOBS.map((job) => known(job, "enabled")), triggerRow("nightly")]
  const { fetchAs } = deployment((call) => call.path === "/api/user" ? Response.json({ id: 1 }) : Response.json(rows))
  for (const job of REPOSITORY_JOBS) {
    const answer = await fetchAs(`/api/repository-setup/state?repo=org%2Frepo&job=${job}`)
    const state = (await answer.json() as SetupRecoveryResponse).registration
    if (state.state !== "known") throw Error(`Expected ${job} to stay known, got ${JSON.stringify(state)}`)
    expect(state.active?.digest).toBe(setupCandidate(initialSetup("org/repo", job, "alice")))
  }
  const listed = await fetchAs(`${TRIGGER_REGISTRATIONS_PATH}?repo=org%2Frepo`)
  expect((await body(listed)).rows).toHaveLength(1)
})

test("the listing names its repository and its session before it spends anything", async () => {
  const { calls, fetchAs } = deployment(() => Response.json([]))
  expect((await body(await fetchAs(`${TRIGGER_REGISTRATIONS_PATH}?repo=not-a-repo`))).code).toBe("request_invalid")
  const signedOut = await fetchAs(`${TRIGGER_REGISTRATIONS_PATH}?repo=org%2Frepo`, { signedIn: false })
  expect((await body(signedOut)).code).toBe("sign_in_required")
  expect((await fetchAs(`${TRIGGER_REGISTRATIONS_PATH}?repo=org%2Frepo`, { method: "POST" })).status).toBe(405)
  expect(calls).toEqual([])
})

test("pause stops one schedule and surfaces Smithers Cloud's own refusal", async () => {
  const stopped = deployment(() => Response.json({ paused: 1 }))
  const answer = await stopped.fetchAs(TRIGGER_PAUSE_PATH, { method: "POST", body: JSON.stringify({ repo: "org/repo", slug: "nightly" }) })
  expect(await body(answer)).toEqual({ status: "ok", paused: 1 })
  expect(stopped.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /api/repos/org/repo/repository-jobs/flow:nightly/pause"])

  const refused = deployment(() => Response.json({ message: "unknown repository job" }, { status: 404 }))
  const unknown = await refused.fetchAs(TRIGGER_PAUSE_PATH, { method: "POST", body: JSON.stringify({ repo: "org/repo", slug: "nightly" }) })
  expect(await body(unknown)).toMatchObject({ code: "upstream_refused", message: "unknown repository job" })

  const invalid = deployment(() => Response.json({}))
  expect((await body(await invalid.fetchAs(TRIGGER_PAUSE_PATH, { method: "POST", body: JSON.stringify({ repo: "org/repo", slug: "NIGHTLY" }) }))).code)
    .toBe("request_invalid")
  expect(invalid.calls).toEqual([])
})

test("the approval receipt sends only what Control produced, and Cloud alone states who approved", async () => {
  const recorded = deployment(() => Response.json({ approved_at: "2026-09-17T06:00:00Z", approved_by: 1 }))
  const answer = await recorded.fetchAs(TRIGGER_APPROVAL_PATH, {
    method: "POST",
    body: JSON.stringify({
      repo: "org/repo", slug: "nightly", planId: "plan-1", planDigest: "d".repeat(64),
      envelope: { capabilities: ["fs:read:**"] }, approvedBy: 99, approvedAt: "1999-01-01T00:00:00Z"
    })
  })
  expect(await body(answer)).toEqual({ status: "ok", approvedAt: "2026-09-17T06:00:00Z", approvedBy: 1 })
  expect(recorded.calls[0]?.path).toBe("/api/repos/org/repo/repository-jobs/flow:nightly/approvals")
  const sent = JSON.parse(recorded.calls[0]?.body ?? "{}") as Record<string, unknown>
  expect(Object.keys(sent).sort()).toEqual(["envelope", "plan_digest", "plan_id"])

  const conflicted = deployment(() => Response.json({ message: "register only the plan a person approved; approve the preview, then apply" }, { status: 409 }))
  const refusal = await conflicted.fetchAs(TRIGGER_APPROVAL_PATH, {
    method: "POST",
    body: JSON.stringify({ repo: "org/repo", slug: "nightly", planId: "plan-1", planDigest: "d".repeat(64), envelope: {} })
  })
  expect(refusal.status).toBe(409)
  expect(await body(refusal)).toMatchObject({
    code: "request_conflict",
    message: "register only the plan a person approved; approve the preview, then apply"
  })

  const silent = deployment(() => Response.json({ ok: true }))
  const malformed = await silent.fetchAs(TRIGGER_APPROVAL_PATH, {
    method: "POST",
    body: JSON.stringify({ repo: "org/repo", slug: "nightly", planId: "plan-1", planDigest: "d".repeat(64), envelope: {} })
  })
  expect((await body(malformed)).code).toBe("upstream_malformed")
})

test("the row reader keeps a trigger and drops everything else", () => {
  expect(triggerRegistrationRow(triggerRow("nightly"))?.slug).toBe("nightly")
  expect(triggerRegistrationRow(known("chores", "enabled"))).toBeUndefined()
  expect(triggerRegistrationRow(triggerRow("Nightly", { job: "flow:Nightly" }))).toBeUndefined()
  expect(triggerRegistrationRow(triggerRow("nightly", { schedule: "" }))).toBeUndefined()
  expect(triggerRegistrationRow(triggerRow("nightly", { next_fire_at: null }))?.nextFireAt).toBeNull()
})
