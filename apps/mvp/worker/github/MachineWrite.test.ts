// Machine writes (worker/github/MachineWrite.ts): the token's scope and end at the route, the App as the author, the
// owner's one dispatcher, a failed write's way back, and `github/Write` left as it was.
import { digestSync } from "@smthrs/crypto"
import { Effect, Exit } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { writeExecutionId } from "../../src/features/issues/contract.ts"
import { FlowStarter } from "../Flows.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as Host from "./Host.ts"
import * as MachineWrite from "./MachineWrite.ts"
import { admit, reset, REPOSITORY, services, signedIn, sql, writeRow } from "./test/fixtures.ts"
import { githubHarness } from "./test/harness.ts"
import { BOT_LOGIN, scriptedGitHub } from "./test/scriptedGitHub.ts"
import * as Write from "./Write.ts"

const runtime = testFile("github_machine_write")
beforeEach(() => reset(runtime))

const TOKEN = "smm_test-token"
const ROUTE = "/api/repos/acme/widgets/writes"
const ALL = "ARRAY['issue/create','issue/update','issue/comment','issue/relate','work/link']::text[]"
const issueToken = (values: { token?: string; repoId?: string; scope?: string; expires?: string; revoked?: string; agent?: string; lane?: string } = {}) =>
  sql(runtime, `INSERT INTO machine_tokens (token_sha256, repo_id, agent, lane, scope, issued_by, expires_at, revoked_at)
    VALUES ('${digestSync(values.token ?? TOKEN)}', '${values.repoId ?? REPOSITORY.id}', '${values.agent ?? "fixer"}', '${values.lane ?? "lane-1"}',
      ${values.scope ?? ALL}, 'test', ${values.expires ?? "now() + interval '1 day'"}, ${values.revoked ?? "NULL"})`)
const post = (body: unknown, token = TOKEN) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
})
const create = (fields: object = {}) => ({ writeId: crypto.randomUUID(), op: "issue/create", title: "Lint panics", body: "What and why.", ...fields })
const machineOf = (lane = "lane-1", token = TOKEN): MachineWrite.Machine => ({ agent: "fixer", lane, scope: [], tokenSha256: digestSync(token) })
const admitAs = (body: unknown, machine = machineOf()) => runtime.runPromise(MachineWrite.admit({ repoId: REPOSITORY.id, owner: "acme", machine, body: body as MachineWrite.MachineBody }))
const row = async (id: string) =>
  ((await sql(runtime, `SELECT status, failure, tries, item_number AS number FROM machine_writes WHERE id = '${id}'`)) as unknown as Array<Record<string, unknown>>)[0]!
/** Lets the next call go at once. */
const clear = () => sql(runtime, `UPDATE machine_dispatch SET next_at = now() - interval '1 second'`)
const posting = (pattern: RegExp) => (method: string, path: string) => method === "POST" && pattern.test(path)
/** The owner's dispatcher, as tests drive it: one tick at a time, on the epoch `launch` answers. */
const dispatcher = async (github: ReturnType<typeof scriptedGitHub>) => {
  const { services: value } = await services(runtime, github)
  const { tick } = MachineWrite.steps(value)
  const epoch = await runtime.runPromise(MachineWrite.launch("acme"))
  let round = 0
  return {
    value,
    epoch,
    tick: () => Effect.runPromise(tick({ owner: "acme", epoch, round: round++, waitMs: 0 })),
    /** The next tick with any hold lifted, as the time passing would. */
    next: async () => {
      await clear()
      return Effect.runPromise(tick({ owner: "acme", epoch, round: round++, waitMs: 0 }))
    },
  }
}

describe("a machine token at the route", () => {
  test("files within its scope, on its repository, until it ends", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const write = create()
    expect((await h.fetch(ROUTE, post(write))).status).toBe(202)
    expect(h.starts).toEqual([{ flow: "github/MachineDispatch", executionId: MachineWrite.dispatchExecutionId("acme", 1), payload: MachineWrite.dispatchPayload("acme", 1) }])
    expect((await h.fetch(ROUTE, post(write))).status).toBe(200)
    expect((await h.fetch(ROUTE, post({ ...write, title: "Other" }))).status).toBe(409)
    await sql(runtime, `UPDATE machine_writes SET status = 'done', item_number = 7 WHERE id = '${write.writeId}'`)
    const status = await h.fetch(`${ROUTE}/${write.writeId}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(await status.json()).toEqual({ status: "done", failure: null, number: 7 })
  })

  test("refuses a token that is unknown, expired, revoked, on another repository or out of scope", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken({ token: "smm_expired", expires: "now() - interval '1 second'" })
    await issueToken({ token: "smm_revoked", revoked: "now()" })
    await issueToken({ token: "smm_elsewhere", repoId: "github/acme/other" })
    await issueToken({ token: "smm_narrow", scope: "ARRAY['issue/comment']::text[]" })
    for (const token of ["smm_nobody", "smm_expired", "smm_revoked", "smm_elsewhere"]) expect((await h.fetch(ROUTE, post(create(), token))).status).toBe(401)
    expect((await h.fetch(ROUTE, post(create(), "smm_narrow"))).status).toBe(403)
    expect(h.starts).toEqual([])
  })

  test("a token revoked or expired while its body arrived admits nothing", async () => {
    await issueToken()
    await sql(runtime, `UPDATE machine_tokens SET revoked_at = now()`)
    expect(await admitAs(create())).toEqual({ kind: "token" })
    await sql(runtime, `UPDATE machine_tokens SET revoked_at = NULL, expires_at = now() - interval '1 second'`)
    expect(await admitAs(create())).toEqual({ kind: "token" })
    expect(await sql(runtime, "SELECT count(*)::int AS count FROM machine_writes")).toEqual([{ count: 0 }])
    await sql(runtime, `UPDATE machine_tokens SET expires_at = now() + interval '1 day'`)
    const links = { links: [{ kind: "queue", ref: "q-1" }] } as never
    await sql(runtime, `UPDATE machine_tokens SET revoked_at = now()`)
    const { write } = await import("./WorkLinks.ts")
    const written = await runtime.runPromise(write(REPOSITORY.id, 3, links, "machine:fixer/lane-1", Date.now(), undefined, { tokenSha256: digestSync(TOKEN) }))
    expect(written._tag).toBe("None")
  })

  test("a person-only act with the same token is refused: triage does not parse, a policy label is refused", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    expect((await h.fetch(ROUTE, post({ writeId: crypto.randomUUID(), op: "issue/triage", number: 1, decision: "accept" }))).status).toBe(400)
    expect((await h.fetch(ROUTE, post({ writeId: crypto.randomUUID(), op: "pr/merge", number: 1, headSha: "a", baseSha: "b" }))).status).toBe(400)
    for (const label of ["smithers:accepted", "smithers:not-accepted", "smithers:commit-now", "SMITHERS:Commit-Next", " smithers:accepted"]) {
      expect((await h.fetch(ROUTE, post(create({ labels: ["bug", label] })))).status, label).toBe(403)
    }
    expect((await h.fetch(ROUTE, post(create({ labels: ["bug", "migrate:alchemy"] })))).status).toBe(202)
    expect(h.starts).toHaveLength(1)
    expect(await sql(runtime, "SELECT count(*)::int AS count FROM github_writes")).toEqual([{ count: 0 }])
  })

  test("refuses credential-shaped text and home paths in anything it would publish, naming the kind only", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const secret = `smm_${"a".repeat(43)}`
    for (const [fields, reason] of [
      [{ body: `leaked ${secret}` }, "credential"],
      [{ title: `leaked ${secret}` }, "credential"],
      [{ labels: [secret] }, "credential"],
      [{ body: "ghp_0123456789abcdefABCDEF0123" }, "credential"],
      [{ body: "see /Users/someone/work/x" }, "home_path"],
      [{ body: "see /home/lane/vibe and more" }, "home_path"],
      [{ body: "see ~/lanes/fix" }, "home_path"],
    ] as const) {
      const response = await h.fetch(ROUTE, post(create(fields)))
      expect(response.status).toBe(422)
      const answer = await response.text()
      expect(JSON.parse(answer)).toEqual({ code: "public_content", reason })
      expect(answer).not.toContain(secret)
    }
    // A repository path with `home` in it is no home path.
    expect((await h.fetch(ROUTE, post(create({ body: "packages/website/src/page/home/x.ts" })))).status).toBe(202)
    const links = { links: [{ kind: "queue", ref: secret }] }
    expect((await h.fetch(`/api/repos/acme/widgets/issues/3/links`, post(links))).status).toBe(400)
  })

  test("finds a token behind Markdown and in encoded URLs", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const secret = `smm_${"a".repeat(43)}`
    for (const body of [`_${secret}_`, `*${secret}*`, `x${secret}`, `https://x.test/?a=%73mm%5f${"a".repeat(43)}`, `https://x.test/?a=%2573mm%255f${"a".repeat(43)}`, `&#115;mm_${"a".repeat(43)}`, `&#x73;mm_${"a".repeat(43)}`, `SMM_${"a".repeat(43)}`]) {
      expect((await h.fetch(ROUTE, post(create({ body })))).status, body).toBe(422)
    }
    expect((await h.fetch(ROUTE, post(create({ body: "100%25 of the smm_ prefix" })))).status).toBe(202)
  })

  test("a write id's casing is the same write", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const write = create()
    const first = await h.fetch(ROUTE, post({ ...write, writeId: write.writeId.toUpperCase() }))
    expect(first.status).toBe(202)
    expect(await first.json()).toEqual({ writeId: write.writeId })
    expect((await h.fetch(ROUTE, post(write))).status).toBe(200)
    expect(await sql(runtime, "SELECT id::text AS id FROM machine_writes")).toEqual([{ id: write.writeId }])
    expect((await h.fetch(`${ROUTE}/${write.writeId.toUpperCase()}`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200)
    // A retry answers the canonical id, however the path spelled it.
    await sql(runtime, `UPDATE machine_writes SET status = 'failed'`)
    const again = await h.fetch(`${ROUTE}/${write.writeId.toUpperCase()}/retry`, post({}))
    expect(await again.json()).toEqual({ writeId: write.writeId, status: "pending" })
  })

  test("a sub-issue across repositories needs this agent and lane to hold the parent's repository too", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const relate = () => ({ writeId: crypto.randomUUID(), op: "issue/relate", number: 2, parent: { repo: "acme/plan", number: 1 } })
    expect((await h.fetch(ROUTE, post(relate()))).status).toBe(403)
    await issueToken({ token: "smm_other-lane", repoId: "github/acme/plan", lane: "lane-2" })
    expect((await h.fetch(ROUTE, post(relate()))).status).toBe(403)
    await issueToken({ token: "smm_narrow", repoId: "github/acme/plan", scope: "ARRAY['issue/create']::text[]" })
    expect((await h.fetch(ROUTE, post(relate()))).status).toBe(403)
    await issueToken({ token: "smm_parent", repoId: "github/acme/plan" })
    expect((await h.fetch(ROUTE, post(relate()))).status).toBe(202)
    // The same repository needs no second token.
    expect((await h.fetch(ROUTE, post({ ...relate(), parent: { repo: "acme/widgets", number: 1 } }))).status).toBe(202)
  })

  test("a write belongs to its agent and lane: another lane can't read or resubmit it", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    await issueToken({ token: "smm_lane-2", lane: "lane-2" })
    const write = create()
    expect((await h.fetch(ROUTE, post(write))).status).toBe(202)
    expect((await h.fetch(ROUTE, post(write, "smm_lane-2"))).status).toBe(409)
    expect((await h.fetch(`${ROUTE}/${write.writeId}`, { headers: { authorization: "Bearer smm_lane-2" } })).status).toBe(404)
  })

  test("one token's backlog is bounded, and a settled write frees its place", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    await issueToken({ token: "smm_lane-2", lane: "lane-2" })
    const first = create()
    expect((await h.fetch(ROUTE, post(first))).status).toBe(202)
    for (let i = 1; i < MachineWrite.MAX_BACKLOG; i++) expect((await h.fetch(ROUTE, post(create()))).status).toBe(202)
    const refused = await h.fetch(ROUTE, post(create()))
    expect(refused.status).toBe(429)
    expect(refused.headers.get("retry-after")).toBe("30")
    // The same write again still answers, and another token has its own bound.
    expect((await h.fetch(ROUTE, post(first))).status).toBe(200)
    expect((await h.fetch(ROUTE, post(create(), "smm_lane-2"))).status).toBe(202)
    await sql(runtime, `UPDATE machine_writes SET status = 'done' WHERE id = '${first.writeId}'`)
    expect((await h.fetch(ROUTE, post(create()))).status).toBe(202)
  })

  test("work links: within scope, as the machine, and never over another source's link", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    await issueToken({ token: "smm_narrow", scope: "ARRAY['issue/create']::text[]" })
    await issueToken({ token: "smm_lane-2", lane: "lane-2" })
    const route = "/api/repos/acme/widgets/issues/3/links"
    const links = (state: string, at: string) => ({ links: [{ kind: "queue", ref: "q-1", state, at }] })
    const soon = (ms: number) => new Date(Date.now() - 60_000 + ms).toISOString()
    expect((await h.fetch(route, post(links("queued", soon(0)), "smm_narrow"))).status).toBe(403)
    expect((await h.fetch(route, post(links("queued", soon(0))))).status).toBe(200)
    const answer = await h.fetch(route, post(links("failed", soon(1000)), "smm_lane-2"))
    expect(answer.status).toBe(200)
    expect(await answer.json()).toMatchObject({ changed: 0 })
    expect(await sql(runtime, "SELECT source, state FROM work_links")).toEqual([{ source: "machine:fixer/lane-1", state: "queued" }])
    expect((await h.fetch(route, post(links("passed", soon(2000))))).status).toBe(200)
    expect(await sql(runtime, "SELECT source, state FROM work_links")).toEqual([{ source: "machine:fixer/lane-1", state: "passed" }])
  })
})

describe("github/MachineDispatch", () => {
  // A real flow: its second round sleeps the real 7.5 s spacing after the send, so it needs more than the default 30 s
  // on a loaded host.
  test("the flow runs the queue to empty and stops: the App is the author, the body says which agent, labels go on", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const write = create({ labels: ["migrate:alchemy"] }) as { writeId: string }
    await admitAs(write)
    const { services: value } = await services(runtime, github)
    const epoch = await runtime.runPromise(MachineWrite.launch("acme"))
    const ran = await runFlow(MachineWrite.MachineDispatch, MachineWrite.dispatchPayload("acme", epoch), MachineWrite.registration(value), { executionId: MachineWrite.dispatchExecutionId("acme", epoch), maxConnections: 3 })
    expect(Exit.isSuccess(ran.exit)).toBe(true)
    const made = github.issues.get(1)!
    expect(made.login).toBe(BOT_LOGIN)
    expect(made.body).toContain("Filed by the agent fixer, lane lane-1.")
    expect(made.labels).toContain("migrate:alchemy")
    expect(github.seen("POST", /\/issues$/).map((call) => call.token)).toEqual(["installation"])
    expect(await row(write.writeId)).toMatchObject({ status: "done", number: 1 })
    expect(await sql(runtime, "SELECT running FROM machine_dispatch")).toEqual([{ running: false }])
  }, 120_000)

  test("recovers its own issue by its marker, and files a sub-issue, looking first", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const parent = create() as { writeId: string }
    await admitAs(parent)
    // The answer to the first POST is lost: GitHub made it, and the next tick finds it instead of making another.
    github.faults.push({ match: posting(/\/issues$/), lost: true })
    const d = await dispatcher(github)
    await d.tick()
    expect(github.issues.size).toBe(1)
    await d.next()
    expect(await row(parent.writeId)).toMatchObject({ status: "done", number: 1 })
    expect(github.issues.size).toBe(1)

    const child = create({ title: "Child" }) as { writeId: string }
    await admitAs(child)
    await d.next()
    const relate = (number: number) => ({ writeId: crypto.randomUUID(), op: "issue/relate", number: 2, parent: { repo: "acme/widgets", number } })
    const first = relate(1)
    await admitAs(first)
    await d.next()
    expect(await row(first.writeId)).toMatchObject({ status: "done" })
    expect(github.subIssueParents.get(2)).toBe(1)
    const posts = github.seen("POST", /sub_issues$/).length
    const again = relate(1)
    await admitAs(again)
    await d.next()
    expect(await row(again.writeId)).toMatchObject({ status: "done" })
    expect(github.seen("POST", /sub_issues$/)).toHaveLength(posts)
    const other = relate(9)
    await admitAs(other)
    await d.next()
    expect(await row(other.writeId)).toMatchObject({ status: "refused", failure: "has_parent" })
  })

  test("F1 a pending write stops when its token, or its parent's, is revoked", async () => {
    await issueToken()
    await issueToken({ token: "smm_parent", repoId: "github/acme/plan" })
    const github = scriptedGitHub()
    const first = create() as { writeId: string }
    await admitAs(first)
    const d = await dispatcher(github)
    await d.tick()
    const relate = { writeId: crypto.randomUUID(), op: "issue/relate", number: 1, parent: { repo: "acme/plan", number: 1 } }
    await admitAs(relate)
    await sql(runtime, `UPDATE machine_tokens SET revoked_at = now() WHERE repo_id = 'github/acme/plan'`)
    await d.next()
    expect(await row(relate.writeId)).toMatchObject({ status: "refused", failure: "revoked" })
    const second = create() as { writeId: string }
    await admitAs(second)
    await sql(runtime, `UPDATE machine_tokens SET revoked_at = now()`)
    await d.next()
    expect(await row(second.writeId)).toMatchObject({ status: "refused", failure: "revoked" })
    expect(github.seen("POST", /sub_issues$/)).toHaveLength(0)
  })

  test("F2 update: only the lane that filed it, and only what this App wrote", async () => {
    await issueToken()
    await issueToken({ token: "smm_lane-2", lane: "lane-2" })
    const github = scriptedGitHub()
    const write = create() as { writeId: string }
    await admitAs(write)
    const d = await dispatcher(github)
    await d.tick()

    const laneTwo = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "closed" }
    await admitAs(laneTwo, machineOf("lane-2", "smm_lane-2"))
    await d.next()
    expect(await row(laneTwo.writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })

    const update = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, title: "Renamed", body: "New words.", state: "closed" }
    await admitAs(update)
    await d.next()
    expect(await row(update.writeId)).toMatchObject({ status: "done", number: 1 })
    const made = github.issues.get(1)!
    expect(made).toMatchObject({ title: "Renamed", state: "closed" })
    expect(made.body).toContain("New words.")
    const [{ recovery }] = (await sql(runtime, `SELECT recovery_id::text AS recovery FROM machine_writes WHERE id = '${write.writeId}'`)) as unknown as Array<{ recovery: string }>
    expect(made.body).toContain(`<!-- smithers:write=${recovery} -->`)
    expect(made.body).not.toContain(write.writeId)

    // Another App's bot, even on an issue the row says this lane filed.
    ;(made as { login: string | null }).login = "other-app[bot]"
    const other = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "open" }
    await admitAs(other)
    await d.next()
    expect(await row(other.writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })
  })

  test("F5 a 2xx with truncated JSON costs a try, and the next tick finds the issue by its marker; a poison write settles", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const write = create() as { writeId: string }
    await admitAs(write)
    github.faults.push({ match: posting(/\/issues$/), malformed: true })
    const d = await dispatcher(github)
    expect(await d.tick()).toMatchObject({ stop: false })
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done", number: 1 })
    expect(github.issues.size).toBe(1)
    // A write that keeps not finishing settles `failed`, and the queue goes on to the next.
    const stuck = create({ title: "Stuck" }) as { writeId: string }
    await admitAs(stuck)
    await sql(runtime, `UPDATE machine_writes SET tries = ${MachineWrite.MAX_TRIES} WHERE id = '${stuck.writeId}'`)
    const after = create({ title: "After" }) as { writeId: string }
    await admitAs(after)
    await d.next()
    expect(await row(stuck.writeId)).toMatchObject({ status: "failed", failure: "exhausted" })
    await d.next()
    expect(await row(after.writeId)).toMatchObject({ status: "done" })
  })

  test("a token GitHub won't give for the parent right now keeps the write; only a real refusal settles it", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const { services: value } = await services(runtime, github)
    const parent = create() as { writeId: string }
    await admitAs(parent)
    const child = create({ title: "Child" }) as { writeId: string }
    await admitAs(child)
    const d = await dispatcher(github)
    await d.tick()
    await d.next()
    const relate = { writeId: crypto.randomUUID(), op: "issue/relate", number: 2, parent: { repo: "acme/widgets", number: 1 } }
    await admitAs(relate)
    // The child's token comes first and the parent's second, so each case fails the second mint.
    const failingSecond = (failure: object) => {
      let mints = 0
      return MachineWrite.steps({
        ...value,
        tokens: { ...value.tokens, forInstallation: (...args: Parameters<typeof value.tokens.forInstallation>) => (++mints === 2 ? Effect.fail(failure) : value.tokens.forInstallation(...args)) } as never,
      })
    }
    await clear()
    await Effect.runPromise(failingSecond({ reason: "rate_limited", retryAfterMillis: 600_000 }).tick({ owner: "acme", epoch: d.epoch, round: 100, waitMs: 0 }))
    expect(await row(relate.writeId)).toMatchObject({ status: "pending" })
    await clear()
    await Effect.runPromise(failingSecond({ reason: "outage" }).tick({ owner: "acme", epoch: d.epoch, round: 101, waitMs: 0 }))
    expect(await row(relate.writeId)).toMatchObject({ status: "pending" })
    await clear()
    await Effect.runPromise(failingSecond({ reason: "app_not_installed" }).tick({ owner: "acme", epoch: d.epoch, round: 102, waitMs: 0 }))
    expect(await row(relate.writeId)).toMatchObject({ status: "refused", failure: "app_not_installed" })
  })

  test("F5 a defect settles that write failed, and the queue goes on", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const { services: value } = await services(runtime, github)
    const write = create() as { writeId: string }
    await admitAs(write)
    const after = create({ title: "After" }) as { writeId: string }
    await admitAs(after)
    const dying = MachineWrite.steps({ ...value, tokens: { ...value.tokens, forInstallation: () => Effect.die("boom") } as never })
    const epoch = await runtime.runPromise(MachineWrite.launch("acme"))
    expect(await Effect.runPromise(dying.tick({ owner: "acme", epoch, round: 0, waitMs: 0 }))).toMatchObject({ stop: false })
    expect(await row(write.writeId)).toMatchObject({ status: "failed", failure: "defect" })
    await Effect.runPromise(MachineWrite.steps(value).tick({ owner: "acme", epoch, round: 1, waitMs: 0 }))
    expect(await row(after.writeId)).toMatchObject({ status: "done" })
  })

  test("F8 first in, first served: waiting spends no try, and every write of every token is served", async () => {
    const github = scriptedGitHub()
    const writes: Array<{ writeId: string }> = []
    for (const lane of ["a", "b", "c"]) {
      await issueToken({ token: `smm_${lane}`, lane })
      for (let i = 0; i < 3; i++) {
        const write = create({ title: `${lane}${i}` }) as { writeId: string }
        await admitAs(write, machineOf(lane, `smm_${lane}`))
        writes.push(write)
      }
    }
    const d = await dispatcher(github)
    // Held: a thousand ticks' worth of waiting takes nothing from anyone.
    await sql(runtime, `UPDATE machine_dispatch SET next_at = now() + interval '1 hour'`)
    for (let i = 0; i < 5; i++) expect((await d.tick()).waitMs).toBeGreaterThan(3_000_000)
    expect(await sql(runtime, "SELECT max(tries) AS tries FROM machine_writes")).toEqual([{ tries: 0 }])
    for (let i = 0; i < writes.length; i++) await d.next()
    for (const write of writes) expect(await row(write.writeId)).toMatchObject({ status: "done" })
    expect([...github.issues.values()].map((issue) => issue.title)).toEqual(["a0", "a1", "a2", "b0", "b1", "b2", "c0", "c1", "c2"])
    expect(await d.next()).toEqual({ stop: true, waitMs: 0 })
  })

  test("F9 the next call waits 7.5 s from the end of a send, however long the send took", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const a = create({ title: "A" }) as { writeId: string }
    await admitAs(a)
    const b = create({ title: "B" }) as { writeId: string }
    await admitAs(b)
    let release = () => {}
    github.faults.push({ match: posting(/\/issues$/), hold: () => new Promise<void>((r) => { release = r }) })
    const d = await dispatcher(github)
    const first = d.tick()
    await vi.waitFor(() => expect(github.seen("POST", /\/issues$/)).toHaveLength(1))
    // Another tick while the send is open, as a replaced run's would be: the hold stops it before any call.
    const calls = github.calls.length
    expect((await d.tick()).waitMs).toBeGreaterThan(0)
    expect(github.calls).toHaveLength(calls)
    // The send is still open here, after the tick above, so a hold counted from its start falls short below.
    // Read on the database's clock, which sets the hold, so no margin depends on how busy this machine is.
    const ms = async (expression: string) => Number(((await sql(runtime, `SELECT extract(epoch FROM ${expression}) * 1000 AS ms FROM machine_dispatch`)) as unknown as Array<{ ms: string }>)[0]!.ms)
    const released = await ms("clock_timestamp()")
    release()
    const outcome = await first
    expect(await ms("next_at") - released).toBeGreaterThanOrEqual(7_500)
    expect(outcome.waitMs).toBeLessThanOrEqual(7_500)
    const again = await d.tick()
    expect(again.waitMs).toBeGreaterThan(0)
    expect(github.seen("POST", /\/issues$/)).toHaveLength(1)
    expect(await row(b.writeId)).toMatchObject({ status: "pending", tries: 0 })
  })

  test("F10 a limit on a read holds everything for the server's wait, and a hold stops reads and tokens", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const write = create() as { writeId: string }
    await admitAs(write)
    github.faults.push({ match: (method, path) => method === "GET" && /\/issues/.test(path), status: 403, headers: { "retry-after": "600" } })
    const d = await dispatcher(github)
    const out = await d.tick()
    expect(out.waitMs).toBeGreaterThan(590_000)
    // The limit spent no try.
    expect(await row(write.writeId)).toMatchObject({ tries: 0 })
    const calls = github.calls.length
    expect((await d.tick()).waitMs).toBeGreaterThan(590_000)
    expect(github.calls).toHaveLength(calls)

    // On a send too, with the penalty doubling when no wait is named, and back after a success.
    await clear()
    await sql(runtime, `UPDATE machine_dispatch SET penalty_ms = 120000`)
    github.faults.push({ match: posting(/\/issues$/), status: 429 })
    expect((await d.tick()).waitMs).toBeGreaterThan(110_000)
    expect(await sql(runtime, `SELECT penalty_ms AS penalty FROM machine_dispatch`)).toEqual([{ penalty: 240000 }])
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done" })
    expect(await sql(runtime, `SELECT penalty_ms AS penalty FROM machine_dispatch`)).toEqual([{ penalty: 60000 }])
  })

  test("F11 a limit on a mint or an installation lookup holds everything for the server's full wait, and spends no try", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const write = create() as { writeId: string }
    await admitAs(write)
    const d = await dispatcher(github)
    // As GitHub answers a secondary limit: the shared client reads a 403 as a limit only with its message.
    const limited = { status: 403, headers: { "retry-after": "600" }, message: "You have exceeded a secondary rate limit" }
    github.faults.push({ match: (method, path) => method === "GET" && path.endsWith("/installation"), ...limited })
    expect((await d.tick()).waitMs).toBeGreaterThan(590_000)
    expect(await row(write.writeId)).toMatchObject({ status: "pending", tries: 0 })
    await clear()
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/access_tokens"), ...limited })
    expect((await d.tick()).waitMs).toBeGreaterThan(590_000)
    expect(await row(write.writeId)).toMatchObject({ status: "pending", tries: 0 })
    // No wait named: the shared penalty holds, and doubles.
    await clear()
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/access_tokens"), status: 429 })
    const penalty = (await d.tick()).waitMs
    expect(penalty).toBeGreaterThan(100_000)
    expect(await row(write.writeId)).toMatchObject({ status: "pending", tries: 0 })
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done" })
  })

  test("F11 a limit GitHub says only in its headers holds the same, on a lookup and on a mint", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const write = create() as { writeId: string }
    await admitAs(write)
    const d = await dispatcher(github)
    const bare = { status: 403, headers: { "retry-after": "600" } }
    github.faults.push({ match: (method, path) => method === "GET" && path.endsWith("/installation"), ...bare })
    expect((await d.tick()).waitMs).toBeGreaterThan(590_000)
    expect(await row(write.writeId)).toMatchObject({ status: "pending", tries: 0 })
    await clear()
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/access_tokens"), ...bare })
    expect((await d.tick()).waitMs).toBeGreaterThan(590_000)
    expect(await row(write.writeId)).toMatchObject({ status: "pending", tries: 0 })
    await clear()
    const reset = String(Math.floor(Date.now() / 1000) + 900)
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/access_tokens"), status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } })
    expect((await d.tick()).waitMs).toBeGreaterThan(800_000)
    expect(await row(write.writeId)).toMatchObject({ status: "pending", tries: 0 })
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done" })
  })

  test("a write admitted while the dispatcher stops is still served", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const d = await dispatcher(github)
    // Another request holds the owner's row, as a launch does, while the tick finds the queue empty and stops.
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let locked = () => {}
    const holding = new Promise<void>((resolve) => { locked = resolve })
    const holder = runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.withTransaction(Effect.gen(function* () {
        yield* sql`UPDATE machine_dispatch SET running = true WHERE owner = 'acme'`
        locked()
        yield* Effect.promise(() => gate)
      }))))
    await holding
    const ticked = d.tick()
    // The tick has read an empty queue and waits on the row: Postgres shows a lock not granted.
    await vi.waitFor(async () =>
      expect(await sql(runtime, "SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted")).not.toEqual([{ waiting: 0 }]))
    const write = create() as { writeId: string }
    await admitAs(write)
    release()
    await holder
    // The holder was this write's launch, which found the epoch running: stopping now would strand the write.
    expect(await ticked).toMatchObject({ stop: false })
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done" })
  })

  test("a run killed after GitHub made it and before the database heard makes nothing twice", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const { services: value } = await services(runtime, github)
    const d = await dispatcher(github)
    /** The process stops the moment a mutation of `pattern` has succeeded, before anything is written down. */
    const crashingAfter = (pattern: RegExp) => MachineWrite.steps({
      ...value,
      http: HttpClient.tap(value.http, (response) =>
        response.request.method === "POST" && pattern.test(new URL(response.request.url).pathname) ? Effect.interrupt : Effect.void),
    })
    let round = 100
    const crash = async (pattern: RegExp) => {
      await clear()
      return Effect.runPromiseExit(crashingAfter(pattern).tick({ owner: "acme", epoch: d.epoch, round: round++, waitMs: 0 }))
    }

    const issue = create() as { writeId: string }
    await admitAs(issue)
    expect(Exit.hasInterrupts(await crash(/\/issues$/))).toBe(true)
    expect(github.issues.size).toBe(1)
    expect(await row(issue.writeId)).toMatchObject({ status: "pending", number: null })
    await d.next()
    expect(await row(issue.writeId)).toMatchObject({ status: "done", number: 1 })
    expect(github.issues.size).toBe(1)
    expect(github.seen("POST", /\/issues$/)).toHaveLength(1)

    const note = { writeId: crypto.randomUUID(), op: "issue/comment", number: 1, body: "Noted." }
    await admitAs(note)
    expect(Exit.hasInterrupts(await crash(/\/comments$/))).toBe(true)
    expect(await row(note.writeId)).toMatchObject({ status: "pending" })
    await d.next()
    expect(await row(note.writeId)).toMatchObject({ status: "done", number: 1 })
    expect(github.seen("POST", /\/comments$/)).toHaveLength(1)
  })

  test("the deployment's allowed list holds when the write runs: its repository and its parent's", async () => {
    await issueToken()
    await issueToken({ token: "smm_parent", repoId: "github/acme/plan" })
    const github = scriptedGitHub()
    const { services: value } = await services(runtime, github)
    const d = await dispatcher(github)
    const tick = (mayAct: (id: string) => boolean) => async () => {
      await clear()
      return Effect.runPromise(MachineWrite.steps({ ...value, mayAct }).tick({ owner: "acme", epoch: d.epoch, round: Math.floor(Math.random() * 1e9), waitMs: 0 }))
    }
    const posts = () => github.calls.filter((call) => call.method === "POST" && !call.path.endsWith("/access_tokens")).length
    const issue = create() as { writeId: string }
    await admitAs(issue)
    await tick((id) => id !== REPOSITORY.id)()
    expect(await row(issue.writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })
    const relate = { writeId: crypto.randomUUID(), op: "issue/relate", number: 1, parent: { repo: "acme/plan", number: 1 } }
    await admitAs(relate)
    await tick((id) => id !== "github/acme/plan")()
    expect(await row(relate.writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })
    expect(posts()).toBe(0)
  })

  test("a slash in a token's agent or lane can't reach the table", async () => {
    await expect(issueToken({ token: "smm_a", agent: "a/b" })).rejects.toThrow()
    await expect(issueToken({ token: "smm_b", lane: "b/c" })).rejects.toThrow()
  })

  test("a permission 403 with a future reset and budget left is a refusal, never retried", async () => {
    const reset_ = String(Math.floor(Date.now() / 1000) + 3000)
    expect(MachineWrite.readAnswer(403, new Headers({ "x-ratelimit-reset": reset_, "x-ratelimit-remaining": "4000" }), { message: "Resource not accessible by integration" }, Date.now()))
      .toEqual({ kind: "refused", failure: "not_allowed" })
    expect(MachineWrite.readAnswer(403, new Headers({ "x-ratelimit-reset": reset_, "x-ratelimit-remaining": "0" }), {}, 0)).toMatchObject({ kind: "limited" })
    expect(MachineWrite.readAnswer(403, new Headers({ "retry-after": "5" }), {}, 0)).toEqual({ kind: "limited", hintMs: 5000 })
    expect(MachineWrite.readAnswer(403, new Headers(), { message: "You have exceeded a secondary rate limit" }, 0)).toEqual({ kind: "limited", hintMs: null })
    expect(MachineWrite.readAnswer(422, new Headers(), {}, 0)).toEqual({ kind: "refused", failure: "invalid" })
  })

  test("an epoch past its lease is replaced, and its old tick stops itself; a live one is left alone", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const write = create() as { writeId: string }
    await admitAs(write)
    const d = await dispatcher(github)
    expect(await runtime.runPromise(MachineWrite.launch("acme"))).toBe(d.epoch)
    await sql(runtime, `UPDATE machine_dispatch SET due_at = now() - interval '11 minutes'`)
    const next = await runtime.runPromise(MachineWrite.launch("acme"))
    expect(next).toBe(d.epoch + 1)
    expect(await d.tick()).toEqual({ stop: true, waitMs: 0 })
    expect(github.seen("POST", /\/issues$/)).toHaveLength(0)
  })
})

describe("a failed write's way back", () => {
  test("F1 a retry needs the op's scope and the parent's repository", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const write = create()
    await h.fetch(ROUTE, post(write))
    await sql(runtime, `UPDATE machine_writes SET status = 'failed'`)
    await sql(runtime, `UPDATE machine_tokens SET scope = ARRAY['work/link']::text[]`)
    expect((await h.fetch(`${ROUTE}/${write.writeId}/retry`, post({}))).status).toBe(403)
    await sql(runtime, `UPDATE machine_tokens SET scope = ${ALL}`)
    await issueToken({ token: "smm_parent", repoId: "github/acme/plan" })
    const relate = { writeId: crypto.randomUUID(), op: "issue/relate", number: 1, parent: { repo: "acme/plan", number: 1 } }
    expect((await h.fetch(ROUTE, post(relate))).status).toBe(202)
    await sql(runtime, `UPDATE machine_writes SET status = 'failed' WHERE id = '${relate.writeId}'`)
    await sql(runtime, `UPDATE machine_tokens SET revoked_at = now() WHERE repo_id = 'github/acme/plan'`)
    expect((await h.fetch(`${ROUTE}/${relate.writeId}/retry`, post({}))).status).toBe(403)
  })

  test("F6 a retry whose start was lost can be asked for again, and starts the owner's current run", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const write = create()
    await h.fetch(ROUTE, post(write))
    await sql(runtime, `UPDATE machine_writes SET status = 'failed'`)
    expect((await h.fetch(`${ROUTE}/${write.writeId}/retry`, post({}))).status).toBe(202)
    expect((await h.fetch(`${ROUTE}/${write.writeId}/retry`, post({}))).status).toBe(202)
    expect((await h.fetch(ROUTE, post(write))).status).toBe(200)
    expect(new Set(h.starts.map((start) => start.executionId))).toEqual(new Set([MachineWrite.dispatchExecutionId("acme", 1)]))
    expect(h.starts).toHaveLength(4)
  })

  test("F6 a start that failed is made good by asking again, on the first send and on a retry", async () => {
    let failing = 0
    const started: Array<string> = []
    const starter = FlowStarter.of({
      start: (_flow: unknown, start: { readonly executionId: string }) =>
        Effect.suspend(() => {
          if (failing > 0) {
            failing -= 1
            return Effect.die("the start was lost")
          }
          started.push(start.executionId)
          return Effect.void
        }),
    } as never)
    const h = await githubHarness(runtime, { actor: null, starter })
    await issueToken()
    const write = create()
    failing = 1
    expect((await h.fetch(ROUTE, post(write))).status).toBe(503)
    expect(await row((write as { writeId: string }).writeId)).toMatchObject({ status: "pending" })
    expect(started).toEqual([])
    expect((await h.fetch(ROUTE, post(write))).status).toBe(200)
    expect(started).toEqual([MachineWrite.dispatchExecutionId("acme", 1)])

    await sql(runtime, `UPDATE machine_writes SET status = 'failed'`)
    failing = 1
    const retry = () => h.fetch(`${ROUTE}/${(write as { writeId: string }).writeId}/retry`, post({}))
    expect((await retry()).status).toBe(503)
    expect(await row((write as { writeId: string }).writeId)).toMatchObject({ status: "pending" })
    expect((await retry()).status).toBe(202)
    expect(started).toHaveLength(2)
  })

  test("a retry holds the deployment's allowed list: its repository and its parent's", async () => {
    const wide = await githubHarness(runtime, { actor: null, allowed: new Set(["github/acme/plan"]) })
    await issueToken()
    await issueToken({ token: "smm_parent", repoId: "github/acme/plan" })
    const relate = { writeId: crypto.randomUUID(), op: "issue/relate", number: 1, parent: { repo: "acme/plan", number: 1 } }
    expect((await wide.fetch(ROUTE, post(relate))).status).toBe(202)
    await sql(runtime, `UPDATE machine_writes SET status = 'failed'`)
    // The parent left the list, its tokens still live.
    const narrow = await githubHarness(runtime, { actor: null, allowed: new Set() })
    expect((await narrow.fetch(`${ROUTE}/${relate.writeId}/retry`, post({}))).status).toBe(403)
    expect(await row(relate.writeId)).toMatchObject({ status: "failed" })
    // Its own repository left it too: this deployment no longer acts there.
    const elsewhere = await githubHarness(runtime, { actor: null, own: { owner: "acme", name: "other", id: "github/acme/other" }, allowed: new Set(["github/acme/plan"]) })
    expect((await elsewhere.fetch(`${ROUTE}/${relate.writeId}/retry`, post({}))).status).toBe(404)
    expect(await row(relate.writeId)).toMatchObject({ status: "failed" })
  })

  test("F7 every way into pending holds the bound, and a replacement token counts it", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    const failed = create()
    await h.fetch(ROUTE, post(failed))
    await sql(runtime, `UPDATE machine_writes SET status = 'failed'`)
    for (let i = 0; i < MachineWrite.MAX_BACKLOG; i++) expect((await h.fetch(ROUTE, post(create()))).status).toBe(202)
    expect((await h.fetch(`${ROUTE}/${failed.writeId}/retry`, post({}))).status).toBe(429)
    expect(await row(failed.writeId)).toMatchObject({ status: "failed" })
    await issueToken({ token: "smm_replacement" })
    expect((await h.fetch(`${ROUTE}/${failed.writeId}/retry`, post({}, "smm_replacement"))).status).toBe(202)
    expect(await sql(runtime, `SELECT count(*)::int AS count FROM machine_writes WHERE token_sha256 = '${digestSync("smm_replacement")}' AND status = 'pending'`)).toEqual([{ count: 1 }])
  })

  test("a failed write goes to the back of the line and stays one issue; another lane can't touch it", async () => {
    const h = await githubHarness(runtime, { actor: null })
    await issueToken()
    await issueToken({ token: "smm_lane-2", lane: "lane-2" })
    const github = scriptedGitHub()
    const write = create()
    expect((await h.fetch(ROUTE, post(write))).status).toBe(202)
    const retry = (token = TOKEN) => h.fetch(`${ROUTE}/${write.writeId}/retry`, post({}, token))
    // GitHub made it, then its tries ran out.
    github.faults.push({ match: posting(/\/issues$/), lost: true })
    const d = await dispatcher(github)
    await d.tick()
    await sql(runtime, `UPDATE machine_writes SET tries = ${MachineWrite.MAX_TRIES}`)
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "failed", failure: "exhausted" })
    // Resubmitting answers what it settled, and starts nothing.
    const starts = h.starts.length
    expect(await (await h.fetch(ROUTE, post(write))).json()).toEqual({ writeId: write.writeId, status: "failed" })
    expect(h.starts).toHaveLength(starts)
    expect((await retry("smm_lane-2")).status).toBe(409)
    expect((await retry()).status).toBe(202)
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done", number: 1 })
    expect(github.issues.size).toBe(1)
  })
})

describe("recovery is the dispatcher's own", () => {
  test("a machine can't adopt an issue github/Write made by sending its marker as a write id", async () => {
    const github = scriptedGitHub()
    github.roles.set("maya", "write")
    const person = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: { op: "issue/create", title: "Theirs", body: "Not the machine's." } })
    const { services: value } = await services(runtime, github)
    await runFlow(Write.Write, { writeId }, Write.registration(value), { executionId: writeExecutionId(writeId), maxConnections: 3 })
    const theirs = github.issues.get(1)!
    expect(theirs.body).toContain(writeId)
    // The strongest case: the App wrote it, so an author check alone would pass it.
    ;(theirs as { login: string | null }).login = BOT_LOGIN

    await issueToken()
    const claim = create({ writeId, title: "Mine now" }) as { writeId: string }
    await admitAs(claim)
    const d = await dispatcher(github)
    await d.tick()
    expect(await row(claim.writeId)).toMatchObject({ status: "done", number: 2 })
    expect(github.issues.size).toBe(2)
    const close = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "closed" }
    await admitAs(close)
    await d.next()
    expect(await row(close.writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })
    expect(github.issues.get(1)!.state).toBe("open")
  })

  test("a marker copied into an older issue someone else wrote is ignored, and the App's issue is found", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const older = create({ title: "Older" }) as { writeId: string }
    await admitAs(older)
    const d = await dispatcher(github)
    await d.tick()
    // Someone else's issue, older than the one about to be made.
    ;(github.issues.get(1)! as { login: string | null }).login = "mallory"
    const write = create({ title: "Mine" }) as { writeId: string }
    await admitAs(write)
    github.faults.push({ match: posting(/\/issues$/), lost: true })
    await d.next()
    expect(github.issues.get(2)!.login).toBe(BOT_LOGIN)
    const [{ recovery }] = (await sql(runtime, `SELECT recovery_id::text AS recovery FROM machine_writes WHERE id = '${write.writeId}'`)) as unknown as Array<{ recovery: string }>
    const theirs = github.issues.get(1)!
    theirs.body = `${theirs.body}\n<!-- smithers:write=${recovery} -->`
    theirs.updatedAt = Date.now()
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done", number: 2 })
    expect(github.issues.size).toBe(2)
  })

  test("an update whose read-back failed never goes after a newer one on the same issue", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const made = create() as { writeId: string }
    await admitAs(made)
    const d = await dispatcher(github)
    await d.tick()
    const close = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "closed" }
    await admitAs(close)
    const reopen = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "open" }
    await admitAs(reopen)
    // The close's PATCH succeeds; the read after it fails.
    let reads = 0
    github.faults.push({ match: (method, path) => method === "GET" && path.endsWith("/issues/1") && ++reads === 2, status: 502 })
    for (let i = 0; i < 4; i++) await d.next()
    expect(await row(reopen.writeId)).toMatchObject({ status: "done" })
    expect(github.issues.get(1)!.state).toBe("open")
    expect(github.seen("PATCH", /\/issues\/1$/)).toHaveLength(2)

    // A failed older update, retried after newer ones succeeded: a field a newer one set is theirs, any other still goes.
    const stale = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "closed", body: "Older words." }
    await admitAs(stale)
    const newer = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, title: "Newer", body: "Newer words." }
    await admitAs(newer)
    await sql(runtime, `UPDATE machine_writes SET status = 'failed' WHERE id = '${stale.writeId}'`)
    await d.next()
    expect(await row(newer.writeId)).toMatchObject({ status: "done" })
    await sql(runtime, `UPDATE machine_writes SET status = 'pending', queued_at = clock_timestamp() WHERE id = '${stale.writeId}'`)
    await d.next()
    expect(await row(stale.writeId)).toMatchObject({ status: "done" })
    expect(github.issues.get(1)!).toMatchObject({ title: "Newer", state: "closed" })
    expect(github.issues.get(1)!.body).toContain("Newer words.")

    // Every field it asked for a newer one has set since: superseded, and nothing is sent.
    const reopen2 = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "open" }
    const closeLate = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "closed" }
    await admitAs(closeLate)
    await admitAs(reopen2)
    await sql(runtime, `UPDATE machine_writes SET status = 'failed' WHERE id = '${closeLate.writeId}'`)
    await d.next()
    expect(await row(reopen2.writeId)).toMatchObject({ status: "done" })
    const patches = github.seen("PATCH", /\/issues\/1$/).length
    await sql(runtime, `UPDATE machine_writes SET status = 'pending', queued_at = clock_timestamp() WHERE id = '${closeLate.writeId}'`)
    await d.next()
    expect(await row(closeLate.writeId)).toMatchObject({ status: "refused", failure: "superseded" })
    expect(github.seen("PATCH", /\/issues\/1$/)).toHaveLength(patches)
    expect(github.issues.get(1)!.state).toBe("open")
  })

  test("an App with its own slug finds its own issue after a lost answer, and may update it", async () => {
    await issueToken()
    const login = "acme-filer[bot]"
    const github = scriptedGitHub("acme", "widgets", login)
    const { services: value } = await services(runtime, github)
    const steps = MachineWrite.steps({ ...value, appLogin: login })
    const epoch = await runtime.runPromise(MachineWrite.launch("acme"))
    let round = 0
    const next = async () => {
      await clear()
      return Effect.runPromise(steps.tick({ owner: "acme", epoch, round: round++, waitMs: 0 }))
    }
    const write = create() as { writeId: string }
    await admitAs(write)
    github.faults.push({ match: posting(/\/issues$/), lost: true })
    await next()
    await next()
    expect(await row(write.writeId)).toMatchObject({ status: "done", number: 1 })
    expect(github.issues.size).toBe(1)
    const update = { writeId: crypto.randomUUID(), op: "issue/update", number: 1, state: "closed" }
    await admitAs(update)
    await next()
    expect(await row(update.writeId)).toMatchObject({ status: "done" })
  })

  test("a marked issue another author wrote is never adopted", async () => {
    await issueToken()
    const github = scriptedGitHub()
    const write = create() as { writeId: string }
    await admitAs(write)
    // The answer is lost, and someone else edits the issue to be theirs: a marker is not a receipt without the App as author.
    github.faults.push({ match: posting(/\/issues$/), lost: true })
    const d = await dispatcher(github)
    await d.tick()
    ;(github.issues.get(1)! as { login: string | null }).login = "mallory"
    await d.next()
    expect(await row(write.writeId)).toMatchObject({ status: "done", number: 2 })
  })
})

describe("github/Write across the change", () => {
  test("a person's write replays on the host with both flows: same plan, no second POST, no machine rows", async () => {
    expect(Write.SEND_VERSION).toBe("github-write/send/v2")
    expect(Host.flows).toContain(Write.Write)
    expect(Host.flows).toContain(MachineWrite.MachineDispatch)
    const github = scriptedGitHub()
    github.roles.set("maya", "write")
    const token = github.userToken("maya")
    const person = await signedIn(runtime, { login: "maya", token })
    const writeId = await admit(runtime, { actorId: person.personId, sessionId: person.sessionId, via: "person", payload: { op: "issue/create", title: "A person's", body: "Theirs." } })
    const { services: value } = await services(runtime, github)
    const before = await runFlow(Write.Write, { writeId }, Write.registration(value), { executionId: writeExecutionId(writeId), maxConnections: 3 })
    expect(before.exit).toEqual(Exit.succeed({ status: "done", itemNumber: 1 }))
    const posts = github.seen("POST", /\/issues$/).length
    const ran = await runFlow(Write.Write, { writeId }, Host.registration(value), { executionId: writeExecutionId(writeId), maxConnections: 3 })
    expect(ran.exit).toEqual(Exit.succeed({ status: "done", itemNumber: 1 }))
    expect(github.seen("POST", /\/issues$/)).toHaveLength(posts)
    expect(github.issues.get(1)!.login).toBe("maya")
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done" })
    expect(await sql(runtime, "SELECT count(*)::int AS count FROM machine_writes")).toEqual([{ count: 0 }])
    expect(await sql(runtime, "SELECT count(*)::int AS count FROM machine_dispatch")).toEqual([{ count: 0 }])
  })
})
