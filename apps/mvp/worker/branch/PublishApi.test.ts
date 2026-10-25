// Publish's and Update branch's doors on the server (docs/features/branch-publish.md#routes): the writes route
// (worker/github/Api.ts) admitting `branch/publish` and `branch/update` through its real handler, with flow starts
// recorded (worker/github/test/harness.ts), and the branch's publication shape (worker/branch/Publications.ts) through
// the branch workspace's real routes and the compose Electric (worker/test/branch.ts).
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { PUBLICATIONS_SHAPE_ROUTE, publishExecutionId, updateExecutionId } from "../../src/features/branch/contract.ts"
import { writesRoute } from "../../src/features/issues/contract.ts"
import type * as Actor from "../Actor.ts"
import { REPOSITORY, reset, sql } from "../github/test/fixtures.ts"
import { githubHarness, member } from "../github/test/harness.ts"
import { branchHarness, type BranchHarness, resetBranches, shared, tracked } from "../test/branch.ts"
import { eventually, testFile } from "../test/harness.ts"
import * as Conversations from "./Conversations.ts"
import * as Publications from "./Publications.ts"

const runtime = testFile("branch_publish_api")

beforeAll(async () => {
  const health = `${await runtime.runPromise(TestDatabase.electricUrl)}/v1/health`
  const response = await fetch(health).catch((error: unknown) => {
    throw TestDatabase.explain("Electric", new URL(health).host)(error)
  })
  if (!response.ok) throw new Error(`Electric answered ${response.status} to ${health}`)
})

beforeEach(async () => {
  await reset(runtime)
  await sql(runtime, "TRUNCATE branch_publications")
  await resetBranches(runtime)
})

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

/** A Smithers-only branch of `repo` owned by `owner`, as `/new` makes it. */
const ephemeral = (owner: string, repo: string = REPOSITORY.id, name = "try-1") =>
  runtime.runPromise(Effect.map(
    Conversations.track(repo, name, "open", "a".repeat(40), owner, undefined, "ephemeral", "deployment"),
    (made) => made.branch.branchId,
  ))

const publishBody = (branchId: string, overrides: Record<string, unknown> = {}) => ({
  writeId: crypto.randomUUID(),
  op: "branch/publish",
  branchId,
  title: "  Add a line  ",
  body: "Why it helps",
  ...overrides,
})

const writes = async () =>
  (await sql(runtime, `SELECT via, op, payload, status FROM github_writes ORDER BY created_at`)) as unknown as Array<{
    readonly via: string
    readonly op: string
    readonly payload: Record<string, unknown>
    readonly status: string
  }>

describe("Publish and Update branch through the writes route", () => {
  test("the owner's Publish: recorded with their session and the trimmed title, branch/Publish started under its id", async () => {
    const actor = member()
    const branchId = await ephemeral(actor.subject.id)
    const h = await githubHarness(runtime, { actor })
    const write = publishBody(branchId.toUpperCase())
    const response = await h.fetch(writesRoute("acme", "widgets"), post(write))
    expect(response.status).toBe(202)
    expect(h.starts).toEqual([{ flow: "branch/Publish", executionId: publishExecutionId(write.writeId), payload: { writeId: write.writeId } }])
    expect(await writes()).toEqual([{
      via: "person",
      op: "branch/publish",
      payload: { op: "branch/publish", branchId, title: "Add a line", body: "Why it helps" },
      status: "pending",
    }])
    // A resend answers the write as it stands.
    const again = await h.fetch(writesRoute("acme", "widgets"), post(write))
    expect([again.status, ((await again.json()) as { readonly status: string }).status]).toEqual([200, "pending"])
  })

  test("Update branch merges by default and takes rebase; the agent may Publish and Update for the person, as the App", async () => {
    const actor = member()
    const branchId = await ephemeral(actor.subject.id)
    const h = await githubHarness(runtime, { actor: { ...actor, act: { kind: "agent", id: "answer-1" } } })
    const merge = { writeId: crypto.randomUUID(), op: "branch/update", branchId }
    const rebase = { writeId: crypto.randomUUID(), op: "branch/update", branchId, method: "rebase" }
    const publish = publishBody(branchId)
    for (const write of [merge, rebase, publish]) expect((await h.fetch(writesRoute("acme", "widgets"), post(write))).status).toBe(202)
    expect(h.starts.map((start) => [start.flow, start.executionId])).toEqual([
      ["branch/Update", updateExecutionId(merge.writeId)],
      ["branch/Update", updateExecutionId(rebase.writeId)],
      ["branch/Publish", publishExecutionId(publish.writeId)],
    ])
    expect((await writes()).map((row) => [row.via, row.payload["method"]])).toEqual([
      ["agent", "merge"],
      ["agent", "rebase"],
      ["agent", undefined],
    ])
  })

  test("a second Publish of a branch while one is on its way is refused conflict; once that settled, the next is taken", async () => {
    const actor = member()
    const branchId = await ephemeral(actor.subject.id)
    const h = await githubHarness(runtime, { actor })
    const first = publishBody(branchId)
    expect((await h.fetch(writesRoute("acme", "widgets"), post(first))).status).toBe(202)
    const second = await h.fetch(writesRoute("acme", "widgets"), post(publishBody(branchId)))
    expect([second.status, await second.json()]).toEqual([409, { code: "conflict" }])
    await sql(runtime, `UPDATE github_writes SET status = 'done', item_number = 4, settled_at = now() WHERE id = '${first.writeId}'`)
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client`
      INSERT INTO branch_publications (branch_id, repo_id, github_ref, base_ref, base_sha, head_sha, pr_number, write_id, pushed_sha)
      VALUES (${branchId}, ${REPOSITORY.id}, 'try-1-0123456789ab', 'main', ${"a".repeat(40)}, ${"b".repeat(40)}, 4, ${first.writeId}, ${"b".repeat(40)})`))
    // The published write's own resend answers as it stands; a new Publish, the branch's next push, is taken.
    expect((await h.fetch(writesRoute("acme", "widgets"), post(first))).status).toBe(200)
    expect((await h.fetch(writesRoute("acme", "widgets"), post(publishBody(branchId)))).status).toBe(202)
    expect(h.starts).toHaveLength(2)
  })

  test.each<readonly [string, (owner: string) => Promise<string>, Actor.Actor | ((owner: string) => Actor.Actor), number, string]>([
    ["someone who may only view the branch", async (owner) => {
      const branchId = await ephemeral(owner)
      await shared(runtime, branchId, "viewer", "view")
      return branchId
    }, { ...member("viewer") }, 403, "forbidden"],
    ["a Member it isn't shared with", (owner) => ephemeral(owner), member(), 403, "forbidden"],
    ["a branch of another repository", (owner) => ephemeral(owner, "github/acme/other"), (owner) => member(owner), 404, "not_found"],
    ["a branch that doesn't exist", () => Promise.resolve(crypto.randomUUID()), (owner) => member(owner), 404, "not_found"],
    ["a Guest, even on their own branch", (owner) => ephemeral(owner), (owner) => ({ ...member(owner), role: "guest" }), 403, "forbidden"],
    ["the owner with no session", (owner) => ephemeral(owner), (owner) => member(owner, null), 401, "authentication"],
  ])("refuses %s: nothing recorded or started", async (_, made, who, status, code) => {
    const owner = crypto.randomUUID()
    const branchId = await made(owner)
    const actor = typeof who === "function" ? who(owner) : who
    const h = await githubHarness(runtime, { actor })
    const response = await h.fetch(writesRoute("acme", "widgets"), post(publishBody(branchId)))
    expect([response.status, await response.json()]).toEqual([status, { code }])
    expect(h.starts).toEqual([])
    expect(await writes()).toEqual([])
  })

  test("refuses an empty title, a branch id that isn't one, and a method GitHub doesn't name", async () => {
    const actor = member()
    const branchId = await ephemeral(actor.subject.id)
    const h = await githubHarness(runtime, { actor })
    for (const write of [
      publishBody(branchId, { title: "   " }),
      publishBody("try-1"),
      { writeId: crypto.randomUUID(), op: "branch/update", branchId, method: "squash" },
    ]) {
      expect((await h.fetch(writesRoute("acme", "widgets"), post(write))).status).toBe(400)
    }
    expect(h.starts).toEqual([])
  })
})

describe("GET /api/shapes/branch-publications", () => {
  const values = async (h: BranchHarness, query: string, count: number) => {
    const rows: Array<Record<string, unknown>> = []
    let at = "offset=-1"
    await eventually(async () => {
      const response = await h.fetch(`${PUBLICATIONS_SHAPE_ROUTE}?${query}&${at}`)
      expect([response.status, response.status === 200 ? "" : await response.text()]).toEqual([200, ""])
      for (const message of (await response.json()) as Array<{ readonly value?: Record<string, unknown> }>) {
        if (message.value !== undefined) rows.push(message.value)
      }
      at = `offset=${response.headers.get("electric-offset")}&handle=${response.headers.get("electric-handle")}`
      return rows.length >= count
    }, 10_000)
    return rows
  }

  const publish = (branchId: string) =>
    runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client`
      INSERT INTO branch_publications (branch_id, repo_id, github_ref, base_ref, base_sha, head_sha, pr_number, write_id, update_state, pushed_sha)
      VALUES (${branchId}, 'github/octocat/spoon-knife', 'try-1-0123456789ab', 'master', ${"a".repeat(40)}, ${"b".repeat(40)}, 7,
        ${crypto.randomUUID()}, 'updated', ${"b".repeat(40)})`))

  test("anyone who may view the branch syncs its publication, without its write id", async () => {
    const branch = await tracked(runtime, "github/octocat/spoon-knife", "try-1", "open", "person-maya")
    await shared(runtime, branch.branchId, "person-ben", "view", "ben")
    await publish(branch.branchId)
    const h = await branchHarness(runtime, { actor: { subject: { kind: "person", id: "person-ben" }, role: "member", login: "ben" } })
    const rows = await values(h, `branch=${branch.branchId}`, 1)
    // Electric sends every value as text; the device's schema reads the number.
    expect(rows).toEqual([expect.objectContaining({ github_ref: "try-1-0123456789ab", pr_number: "7", update_state: "updated" })])
    expect(rows[0]).not.toHaveProperty("write_id")
    expect(h.electric[0]!.searchParams.get("params[1]")).toBe(branch.branchId)
    await eventually(() => h.line("branch.publications.shape").length >= 1)
    expect(h.count(Publications.shapes, { status: "200", live: "false" })).toBeGreaterThanOrEqual(1)
  })

  test("anyone who may not view it, or a request naming no branch, gets a shape with no rows", async () => {
    const branch = await tracked(runtime, "github/octocat/spoon-knife", "try-1", "open", "person-maya")
    await publish(branch.branchId)
    for (const [actor, query] of [
      [null, `branch=${branch.branchId}`],
      [{ subject: { kind: "person" as const, id: "person-gus" }, role: "member" as const }, `branch=${branch.branchId}`],
      [{ subject: { kind: "person" as const, id: "person-maya" }, role: "member" as const }, "branch=not-a-uuid"],
      [{ subject: { kind: "person" as const, id: "person-maya" }, role: "member" as const }, "where=true"],
    ] as const) {
      const h = await branchHarness(runtime, actor === null ? {} : { actor })
      const response = await h.fetch(`${PUBLICATIONS_SHAPE_ROUTE}?offset=-1&${query}`)
      expect([response.status, response.status === 200 ? "" : await response.clone().text()]).toEqual([200, ""])
      expect(((await response.json()) as Array<{ readonly value?: unknown }>).filter((row) => row.value !== undefined)).toEqual([])
      expect(h.electric[0]!.searchParams.get("params[1]")).toBe("00000000-0000-0000-0000-000000000000")
    }
  })

  test("while Postgres can't be read, the request is refused 503 and Electric is never asked", async () => {
    const branch = await tracked(runtime, "github/octocat/spoon-knife", "try-1", "open", "person-maya")
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const h = await branchHarness(runtime, { actor: { subject: { kind: "person", id: "person-maya" }, role: "member" }, database: unreachable })
    const response = await h.fetch(`${PUBLICATIONS_SHAPE_ROUTE}?offset=-1&branch=${branch.branchId}`)
    expect(response.status).toBe(503)
    expect(h.electric).toEqual([])
  })
})
