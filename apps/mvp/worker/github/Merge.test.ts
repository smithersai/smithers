// A person's merge (worker/github/Merge.ts, decision 0012 decision 6) on the Node host's engine over this file's schema
// of the compose Postgres, against the scripted GitHub: the write is admitted as the writes route admits it, then
// `pr/Merge` rechecks what the person saw and merges with their own token, or settles why not.
import { Cause, Effect, Exit, Metric, Option, Redacted } from "effect"
import { HttpClient } from "effect/http"
import { beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import { mergeExecutionId } from "../../src/features/pulls/contract.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import { withToken } from "./Calls.ts"
import * as Merge from "./Merge.ts"
import * as Metrics from "./Metrics.ts"
import { moveBase, readPull } from "./Pulls.ts"
import { TokenUnavailable } from "./Tokens.ts"
import * as Write from "./Write.ts"
import { MERGE_FLOW_FILE, queueMarkerOf } from "../../src/features/pulls/contract.ts"
import { admit, REPOSITORY, reset, services, signedIn, sql, writeRow } from "./test/fixtures.ts"
import { BOT_LOGIN, type ScriptedGitHub, scriptedGitHub } from "./test/scriptedGitHub.ts"

const runtime = testFile("github_merge")
beforeEach(async () => {
  await reset(runtime)
  await sql(runtime, "TRUNCATE pulls, pull_commits, reviews")
})

/** A pull request that adds a line to README.md, opened by the App; with what a person's page shows of it. */
const opened = (github: ScriptedGitHub, branch = "smithers/t1-readme") => {
  const baseSha = github.refs.get("main")!
  const change = branch === "smithers/t1-readme" ? { "README.md": "# Widgets\n\nA line\n" } : { [`${branch}.md`]: "A line\n" }
  const headSha = github.push(branch, change)
  const pull = github.openPull(branch, "T1: README", BOT_LOGIN)
  return { number: pull.number, headSha, baseSha }
}

/** Reads pull requests `numbers` into the projection with the App's token, as the webhook's re-read does. */
const readPulls = (built: Awaited<ReturnType<typeof services>>["services"], numbers: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const token = yield* built.tokens.forInstallation(REPOSITORY, "pulls")
    for (const number of numbers) yield* readPull(REPOSITORY, number).pipe(withToken(token, built.apiBaseUrl))
  }).pipe(Effect.provideService(HttpClient.HttpClient, built.http), Effect.provide(built.database))

/** Maya, a Maintainer signed in, and her merge of `seen`, admitted. */
const merging = async (github: ScriptedGitHub, seen: ReturnType<typeof opened>, sessionId?: string | null) => {
  const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
  const writeId = await admit(runtime, {
    actorId: maya.personId,
    sessionId: sessionId === undefined ? maya.sessionId : sessionId,
    via: "person",
    payload: { op: "pr/merge", number: seen.number, headSha: seen.headSha, baseSha: seen.baseSha, method: "squash" },
  })
  return { maya, writeId }
}

const run = async (github: ScriptedGitHub, writeId: string) => {
  const { services: built } = await services(runtime, github)
  return runFlow(Merge.Merge, { writeId }, Merge.registration(built), { executionId: mergeExecutionId(writeId) })
}

describe("pr/Merge", { timeout: 60_000 }, () => {
  test("a person's merge squashes the head they saw onto main, as them, and settles with the pull request merged", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const { writeId } = await merging(github, seen)
    const ran = await run(github, writeId)
    const pull = github.pulls.get(seen.number)!
    expect(ran.exit).toEqual(Exit.succeed({ status: "done", mergeSha: pull.mergeSha }))
    expect([pull.merged, pull.mergedBy]).toEqual([true, "maya"])
    // The merge commit carries the write's key, which is how a lost answer finds it.
    expect(github.commits.get(github.refs.get("main")!)!.message).toBe(
      `T1: README (#${seen.number})\n\nSmithers-Write: ${Merge.mergeKeyOf(writeId)}`,
    )
    expect(github.tree("main").get("README.md")).toBe("# Widgets\n\nA line\n")
    expect(github.seen("PUT", /\/merge$/).map((call) => call.token)).toEqual(["user"])
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done", itemNumber: seen.number, mergeFlow: "github" })
    expect(await sql(runtime, `SELECT merged, merged_by AS "by" FROM pulls`)).toEqual([{ merged: true, by: "maya" }])
    // No `.smithers/merge.json`: GitHub's merge, the default; and nothing asked any queue.
    expect(github.seen("POST", /\/comments$/)).toHaveLength(0)
  })

  /** What changes on GitHub after the person saw the pull request. */
  type Change = (github: ScriptedGitHub, number: number) => void
  test.each<readonly [string, Change]>([
    ["head_moved", (github) => void github.push("smithers/t1-readme", { "B.md": "b\n" })],
    // GitHub keeps reporting the base the pull request opened on; the step reads the branch itself. Before 2026-10-21 the
    // step compared that snapshot and merged onto the moved main (Codex Astra review).
    ["base_moved", (github) => void github.push("main", { "C.md": "c\n" })],
    ["merged", (github, number) => void github.merge(number)],
    ["closed", (github, number) => github.close(number)],
    ["not_mergeable", (github) => void (github.unmergeable = true)],
  ])("refuses %s: nothing merged, the write settled refused", async (failure, change) => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const { writeId } = await merging(github, seen)
    change(github, seen.number)
    const moved = github.refs.get("main")
    const ran = await run(github, writeId)
    expect(ran.exit).toEqual(Exit.succeed({ status: "refused", mergeSha: null }))
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure })
    expect(github.refs.get("main")).toBe(moved)
  })

  test("a draft is refused draft", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    github.pulls.set(seen.number, { ...github.pulls.get(seen.number)!, draft: true })
    const { writeId } = await merging(github, seen)
    await run(github, writeId)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "draft" })
  })

  test("a merge whose answer was lost is found by the key in its commit message: done once", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const { writeId } = await merging(github, seen)
    github.faults.push({ match: (method, path) => method === "PUT" && path.endsWith("/merge"), lost: true })
    const ran = await run(github, writeId)
    expect(ran.exit).toEqual(Exit.succeed({ status: "done", mergeSha: github.pulls.get(seen.number)!.mergeSha }))
    expect(github.seen("PUT", /\/merge$/)).toHaveLength(1)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done", attempts: 1 })
  })

  test("someone else's merge at the same head, after an attempt that failed to read, is merged: never this write's", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const { writeId } = await merging(github, seen)
    const { services: built } = await services(runtime, github)
    // The first attempt can't read the pull request; meanwhile a person merges it on github.com at the same head.
    github.faults.push({ match: (method, path) => method === "GET" && path.endsWith(`/pulls/${seen.number}`), status: 502 })
    expect(Exit.isFailure(await runtime.runPromise(Effect.exit(Merge.steps(built).send({ writeId }))))).toBe(true)
    github.merge(seen.number, "sam")
    // Before 2026-10-21 the attempt count rose before the read, so this run took sam's merge for its own (Codex Astra).
    expect(await runtime.runPromise(Merge.steps(built).send({ writeId }))).toEqual({ status: "refused", mergeSha: null })
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "merged" })
    expect(github.seen("PUT", /\/merge$/)).toHaveLength(0)
  })

  test("the base moved: refused, and every open pull request into it shows the head read, so Merge again binds it", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const other = opened(github, "smithers/t2-other")
    const { services: built } = await services(runtime, github)
    await runtime.runPromise(readPulls(built, [seen.number, other.number]))
    const moved = github.push("main", { "C.md": "c\n" })
    const { maya, writeId } = await merging(github, seen)
    await run(github, writeId)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "base_moved" })
    expect(await sql(runtime, `SELECT number, base_sha AS "baseSha" FROM pulls ORDER BY number`)).toEqual([
      { number: seen.number, baseSha: moved },
      { number: other.number, baseSha: moved },
    ])
    // Pressed again on the base the page now shows: merged onto it.
    const again = await admit(runtime, {
      actorId: maya.personId,
      sessionId: maya.sessionId,
      via: "person",
      payload: { op: "pr/merge", number: seen.number, headSha: seen.headSha, baseSha: moved, method: "squash" },
    })
    const ran = await run(github, again)
    expect(ran.exit).toEqual(Exit.succeed({ status: "done", mergeSha: github.refs.get("main")! }))
    expect(github.commits.get(github.refs.get("main")!)!.parents).toEqual([moved])
    // After the merge, the other pull request's base is the merge: its Merge needs one press.
    expect(await sql(runtime, `SELECT base_sha AS "baseSha" FROM pulls WHERE number = ${other.number}`)).toEqual([
      { baseSha: github.refs.get("main")! },
    ])
  })

  test("a base branch whose head can't be read is refused, never merged onto GitHub's snapshot", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const { services: built } = await services(runtime, github)
    // A name GitHub allows and the client won't put in a path: the projection shows GitHub's base.sha for it.
    github.pulls.set(seen.number, { ...github.pulls.get(seen.number)!, base: "release;1" })
    await runtime.runPromise(readPulls(built, [seen.number]))
    expect(await sql(runtime, `SELECT base_sha AS "baseSha" FROM pulls`)).toEqual([{ baseSha: seen.baseSha }])
    // Before 2026-10-21's review fix the merge compared that snapshot and merged (Codex Astra).
    const { writeId } = await merging(github, seen)
    await run(github, writeId)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "base_moved" })
    expect(github.seen("PUT", /\/merge$/)).toHaveLength(0)
  })

  test("a merge's settlement landing after a newer base never moves a pull request back", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const other = opened(github, "smithers/t2-other")
    const { services: built } = await services(runtime, github)
    await runtime.runPromise(readPulls(built, [seen.number, other.number]))
    const newer = github.push("main", { "N.md": "n\n" })
    // A later merge or read already showed the newer base; this settlement, checked against the older one, lands late.
    await sql(runtime, `UPDATE pulls SET base_sha = '${newer}'`)
    expect(await runtime.runPromise(moveBase(REPOSITORY.id, seen.number, seen.baseSha, "f".repeat(40)))).toBe(0)
    expect(await sql(runtime, `SELECT DISTINCT base_sha AS "baseSha" FROM pulls`)).toEqual([{ baseSha: newer }])
    expect(await runtime.runPromise(moveBase(REPOSITORY.id, seen.number, newer, "f".repeat(40)))).toBe(2)
  })

  test("a push that lands between the check and GitHub's merge is merged under, and recorded as such", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const { writeId } = await merging(github, seen)
    const { services: built } = await services(runtime, github)
    const registry: Metric.MetricRegistry = new Map()
    const count = (base: Merge.Landed) =>
      Effect.runSync(
        Metric.value(Metric.withAttributes(Merge.merges, { outcome: "done", base, flow: "github" })).pipe(
          Effect.provideService(Metric.MetricRegistry, registry),
        ),
      ).count
    // GitHub's merge has no base precondition: the push lands while the merge request is in flight.
    github.faults.push({
      match: (method, path) => method === "PUT" && path.endsWith("/merge"),
      hold: async () => void github.push("main", { "E.md": "e\n" }),
    })
    const merged = await runtime.runPromise(
      Merge.steps(built).send({ writeId }).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
    )
    expect(merged.status).toBe("done")
    expect([count("moved"), count("seen")]).toEqual([1, 0])
    // The next merge lands where it was checked.
    const next = opened(github, "smithers/t3-next")
    const { writeId: nextId } = await merging(github, next)
    await runtime.runPromise(Merge.steps(built).send({ writeId: nextId }).pipe(Effect.provideService(Metric.MetricRegistry, registry)))
    expect([count("moved"), count("seen")]).toEqual([1, 1])
  })

  test("a squash whose comparison GitHub can't answer is merged all the same, its base unchecked", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const { writeId } = await merging(github, seen)
    const { services: built } = await services(runtime, github)
    const registry: Metric.MetricRegistry = new Map()
    github.faults.push({ match: (method, path) => method === "GET" && path.includes("/compare/"), status: 502 })
    const merged = await runtime.runPromise(
      Merge.steps(built).send({ writeId }).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
    )
    expect(merged.status).toBe("done")
    const unchecked = () =>
      Effect.runSync(
        Metric.value(Metric.withAttributes(Merge.merges, { outcome: "done", base: "unchecked", flow: "github" })).pipe(
          Effect.provideService(Metric.MetricRegistry, registry),
        ),
      ).count
    expect(unchecked()).toBe(1)
    // A merge commit is not one commit on its base: unchecked too.
    const next = opened(github, "smithers/t3-next")
    const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const asMerge = await admit(runtime, {
      actorId: maya.personId,
      sessionId: maya.sessionId,
      via: "person",
      payload: { op: "pr/merge", number: next.number, headSha: next.headSha, baseSha: github.refs.get("main")!, method: "merge" },
    })
    await runtime.runPromise(Merge.steps(built).send({ writeId: asMerge }).pipe(Effect.provideService(Metric.MetricRegistry, registry)))
    expect(await writeRow(runtime, asMerge)).toMatchObject({ status: "done" })
    expect(unchecked()).toBe(2)
  })

  test("a merge another run settles while this one is at GitHub: settling again changes nothing and counts nothing", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const { writeId } = await merging(github, seen)
    const { services: built } = await services(runtime, github)
    const registry: Metric.MetricRegistry = new Map()
    github.faults.push({
      match: (method, path) => method === "PUT" && path.endsWith("/merge"),
      hold: async () => void await sql(runtime, `UPDATE github_writes SET status = 'failed', failure = 'unavailable', settled_at = now() WHERE id = '${writeId}'`),
    })
    await runtime.runPromise(Merge.steps(built).send({ writeId }).pipe(Effect.provideService(Metric.MetricRegistry, registry)))
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "failed", failure: "unavailable" })
    const counted = Effect.runSync(
      Metric.value(Metric.withAttributes(Merge.merges, { outcome: "done", base: "seen" })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    )
    expect(counted.count).toBe(0)
  })

  test("a merge GitHub refused whose answer was lost is unknown: counted, tried again, nothing settled", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const { writeId } = await merging(github, seen)
    const { services: built } = await services(runtime, github)
    const registry: Metric.MetricRegistry = new Map()
    // GitHub refused the merge (a required check) and the answer never arrived: nothing merged, nothing to find.
    github.unmergeable = true
    github.faults.push({ match: (method, path) => method === "PUT" && path.endsWith("/merge"), lost: true })
    const exit = await runtime.runPromise(
      Effect.exit(Merge.steps(built).send({ writeId }).pipe(Effect.provideService(Metric.MetricRegistry, registry))),
    )
    expect(exit._tag === "Failure" && Cause.squash(exit.cause)).toBeInstanceOf(Merge.MergeUnavailable)
    const unknown = Effect.runSync(
      Metric.value(Metric.withAttributes(Metrics.writeUnknown, { op: "pr/merge" })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    )
    expect(unknown.count).toBe(1)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "pending" })
  })

  test("a session that ended is sign_in_required; a write with no session is too", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const { maya, writeId } = await merging(github, seen)
    await sql(runtime, `UPDATE sessions SET revoked_at = now() WHERE id = '${maya.sessionId}'`)
    await run(github, writeId)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "sign_in_required" })
    expect(github.seen("PUT", /\/merge$/)).toHaveLength(0)
  })

  test("GitHub's other refusals: a revoked token, a pull request it no longer has", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const { writeId } = await merging(github, seen)
    github.faults.push({ match: (method, path) => method === "GET" && path.endsWith(`/pulls/${seen.number}`), status: 404 })
    await run(github, writeId)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "not_found" })
  })

  test("a run started again after it settled answers what it settled; an unknown write is missing", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const { writeId } = await merging(github, seen)
    await run(github, writeId)
    const again = await run(github, writeId)
    expect(again.exit).toEqual(Exit.succeed({ status: "done", mergeSha: null }))
    expect(github.seen("PUT", /\/merge$/)).toHaveLength(1)
    const missing = await run(github, crypto.randomUUID())
    expect(missing.exit).toEqual(Exit.succeed({ status: "missing", mergeSha: null }))
  })

  test("giving up settles the write failed unavailable", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const { writeId } = await merging(github, seen)
    const { services: built } = await services(runtime, github)
    const settled = await runtime.runPromise(Merge.steps(built).giveUp({ writeId }))
    expect(settled).toEqual({ status: "failed", mergeSha: null })
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "failed", failure: "unavailable" })
    expect(await runtime.runPromise(Merge.steps(built).giveUp({ writeId: crypto.randomUUID() }))).toEqual({
      status: "missing",
      mergeSha: null,
    })
  })

  test("a merge row with no person's session, which the route never admits, is sign_in_required; nothing reaches GitHub", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const writeId = await admit(runtime, {
      actorId: "agent",
      sessionId: null,
      via: "agent",
      payload: { op: "pr/merge", number: seen.number, headSha: seen.headSha, baseSha: seen.baseSha, method: "squash" },
    })
    await run(github, writeId)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "sign_in_required" })
    expect(github.seen("PUT", /\/merge$/)).toHaveLength(0)
  })

  describe("a step that can't finish now is tried again, keeping the wait it was told", () => {
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    /** Step `send` once over `built`: the wait of the `MergeUnavailable` it failed with, `none` for none. */
    const sendOnce = async (built: Awaited<ReturnType<typeof services>>["services"], writeId: string) => {
      const exit = await runtime.runPromise(Effect.exit(Merge.steps(built).send({ writeId })))
      const error = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
      if (!(error instanceof Merge.MergeUnavailable)) throw new Error(`send didn't fail MergeUnavailable: ${String(error)}`)
      return error.retryAfterMillis ?? "none"
    }

    test("a token being refreshed waits as told; a token GitHub or Postgres couldn't give waits the policy's time", async () => {
      const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
      const { writeId } = await merging(github, opened(github))
      const { services: built } = await services(runtime, github)
      const failing = (failure: TokenUnavailable) => ({ ...built, tokens: { ...built.tokens, forSession: () => Effect.fail(failure) } })
      expect(await sendOnce(failing(new TokenUnavailable({ reason: "refreshing", retryAfterMillis: 5_000 })), writeId))
        .toBe(5_000)
      expect(await sendOnce(failing(new TokenUnavailable({ reason: "unavailable" })), writeId)).toBe("none")
      expect(await writeRow(runtime, writeId)).toMatchObject({ status: "pending" })
    })

    test("GitHub down waits the policy's time, and GitHub's rate limit waits as GitHub said", async () => {
      const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
      const seen = opened(github)
      const { writeId } = await merging(github, seen)
      const { services: built } = await services(runtime, github)
      const pull = (method: string, path: string) => method === "GET" && path.endsWith(`/pulls/${seen.number}`)
      github.faults.push({ match: pull, status: 502 })
      expect(await sendOnce(built, writeId)).toBe("none")
      github.faults.push({ match: pull, status: 429, headers: { "retry-after": "3" } })
      expect(await sendOnce(built, writeId)).toBe(3_000)
      expect(github.seen("PUT", /\/merge$/)).toHaveLength(0)
    })

    test("Postgres down fails send and give-up alike, as unavailable", async () => {
      const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
      const { writeId } = await merging(github, opened(github))
      const { services: built } = await services(runtime, github)
      const down = { ...built, database: unreachable }
      expect(await sendOnce(down, writeId)).toBe("none")
      const gaveUp = await runtime.runPromise(Effect.exit(Merge.steps(down).giveUp({ writeId })))
      expect(gaveUp._tag === "Failure" && String(gaveUp.cause)).toContain("MergeUnavailable")
      expect(await writeRow(runtime, writeId)).toMatchObject({ status: "pending" })
    })
  })

  test("merged without the App's read-back settles done, and its row waits for the webhook", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const { writeId } = await merging(github, seen)
    const { services: built } = await services(runtime, github)
    // The App reads the merge flow (Contents: read, decision 0134), then can't mint the read-back's token.
    const noApp = {
      ...built,
      tokens: {
        ...built.tokens,
        forInstallation: (...args: Parameters<typeof built.tokens.forInstallation>) =>
          args[1] === "contents"
            ? built.tokens.forInstallation(...args)
            : Effect.fail(new TokenUnavailable({ reason: "app_not_installed" })),
      },
    }
    const merged = await runtime.runPromise(Merge.steps(noApp).send({ writeId }))
    expect(merged).toEqual({ status: "done", mergeSha: github.pulls.get(seen.number)!.mergeSha })
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done" })
    expect(await sql(runtime, `SELECT number FROM pulls`)).toEqual([])
  })

  test("giving up on a write already settled changes nothing, and answers what it settled", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const seen = opened(github)
    const { writeId } = await merging(github, seen)
    await run(github, writeId)
    const { services: built } = await services(runtime, github)
    expect(await runtime.runPromise(Merge.steps(built).giveUp({ writeId }))).toEqual({ status: "done", mergeSha: null })
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done" })
  })

  test("github/Write never runs a merge: a merge write handed to it settles refused, and nothing merges", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { writeId } = await merging(github, opened(github))
    const { services: built } = await services(runtime, github)
    const ran = await runFlow(Write.Write, { writeId }, Write.registration(built), { maxConnections: 2 })
    expect(ran.exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "invalid" })
    expect(github.seen("PUT", /\/merge$/)).toHaveLength(0)
  })

  test("GitHub's statuses as a merge's refusal", () => {
    expect([405, 409, 401, 404, 422, 403].map(Merge.refusalOf)).toEqual([
      "not_mergeable",
      "head_moved",
      "sign_in_required",
      "not_found",
      "invalid",
      "not_allowed",
    ])
  })
})


test("projection failure after GitHub merged cannot turn success into a failed write", async () => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  const seen = opened(github)
  const { writeId } = await merging(github, seen)
  const { services: built } = await services(runtime, github)
  const registry: Metric.MetricRegistry = new Map()
  // A real database constraint fails only projection; admission and settlement remain usable.
  await sql(runtime, "ALTER TABLE pulls ADD CONSTRAINT reject_projection CHECK (number < 0)")
  try {
    await runtime.runPromise(Effect.exit(Merge.steps(built).send({ writeId })).pipe(
      Effect.provideService(Metric.MetricRegistry, registry),
    ))
    const failures = await runtime.runPromise(Metric.value(Metric.withAttributes(Metrics.projectionFailures, { op: "pr/merge" })).pipe(
      Effect.provideService(Metric.MetricRegistry, registry),
    ))
    expect(failures.count).toBe(1)
    expect(github.pulls.get(seen.number)!.merged).toBe(true)
    await runtime.runPromise(Merge.steps(built).giveUp({ writeId }))
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done" })
  } finally {
    await sql(runtime, "ALTER TABLE pulls DROP CONSTRAINT reject_projection")
  }
})

test.each(["octocat", "maya"])("a definitive merge refusal cannot recover a later merge by %s", async (login) => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  const seen = opened(github)
  const { writeId } = await merging(github, seen)
  const { services: built } = await services(runtime, github)
  github.faults.push({ match: (method, path) => method === "PUT" && path.endsWith("/merge"), status: 429, headers: { "retry-after": "1" } })
  const sent = await runtime.runPromise(Effect.exit(Merge.steps(built).send({ writeId })))
  expect(sent._tag).toBe("Failure")
  expect(github.seen("PUT", /\/merge$/)).toHaveLength(1)
  github.merge(seen.number, login)
  expect(await runtime.runPromise(Merge.steps(built).send({ writeId }))).toEqual({ status: "refused", mergeSha: null })
  expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "merged" })
})


test("a malformed successful merge response is found by the key in its commit message: done, one merge", async () => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  const seen = opened(github)
  const { writeId } = await merging(github, seen)
  const { services: built } = await services(runtime, github)
  github.faults.push({ match: (method, path) => method === "PUT" && path.endsWith("/merge"), malformed: true })
  expect(await runtime.runPromise(Merge.steps(built).send({ writeId }))).toEqual({ status: "done", mergeSha: github.pulls.get(seen.number)!.mergeSha })
  expect(github.seen("PUT", /\/merge$/)).toHaveLength(1)
})

test("an unknown merge outcome cannot claim a different GitHub person's merge", async () => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  const seen = opened(github)
  const { writeId } = await merging(github, seen)
  const { services: built } = await services(runtime, github)
  github.faults.push({ match: (method, path) => method === "PUT" && path.endsWith("/merge"), status: 503 })
  expect((await runtime.runPromise(Effect.exit(Merge.steps(built).send({ writeId }))))._tag).toBe("Failure")
  github.merge(seen.number, "octocat")
  expect(await runtime.runPromise(Merge.steps(built).send({ writeId }))).toEqual({ status: "refused", mergeSha: null })
  expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "merged" })
})

// The repository's merge flow (ruling BR-7, decision 0134): `.smithers/merge.json` at the base the person saw.
describe("pr/Merge through the repository's merge queue", { timeout: 60_000 }, () => {
  test.each([undefined, 2_000])("an unreadable contents token keeps its retry delay: %s", async (retryAfterMillis) => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { writeId } = await merging(github, opened(github))
    const { services: built } = await services(runtime, github)
    const failed = { ...built, tokens: { ...built.tokens, forInstallation: () => Effect.fail(new TokenUnavailable({ reason: "unavailable", ...(retryAfterMillis === undefined ? {} : { retryAfterMillis }) })) } }
    const answer = await runtime.runPromise(Effect.flip(Merge.steps(failed).send({ writeId })))
    expect(answer).toEqual(new Merge.MergeUnavailable(retryAfterMillis === undefined ? {} : { retryAfterMillis }))
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "pending" })
  })

  test.each(["directory", "forbidden", "limited"] as const)("an unreadable merge file: %s", async (fault) => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { writeId } = await merging(github, opened(github))
    const { services: built } = await services(runtime, github)
    github.faults.push({ match: (method, path) => method === "GET" && path.includes("/contents/"),
      ...(fault === "directory" ? { malformed: true } : { status: fault === "forbidden" ? 403 : 429, headers: { "retry-after": "2" } }),
    })
    const result = await runtime.runPromise(Effect.result(Merge.steps(built).send({ writeId })))
    if (fault === "limited") expect(result).toMatchObject({ _tag: "Failure", failure: { retryAfterMillis: 2_000 } })
    else {
      expect(result).toMatchObject({ _tag: "Success", success: { status: "refused" } })
      expect(await writeRow(runtime, writeId)).toMatchObject({ failure: fault === "directory" ? "invalid" : "not_allowed" })
    }
    expect(github.seen("PUT", /\/merge$/)).toEqual([])
  })
  /** A repository whose main says `{ "flow": "queue" }` (or `text`), and a pull request opened on it. */
  const queueing = (text = `{ "flow": "queue" }\n`) => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.push("main", { [MERGE_FLOW_FILE]: text })
    return { github, seen: opened(github) }
  }

  const requests = (github: ScriptedGitHub, number: number) =>
    github.issues.get(number)!.comments.filter((comment) => comment.body.includes("smithers:merge-queue"))

  test("a queue repository's Merge posts one request as the person, naming the head they saw; nothing merges", async () => {
    const { github, seen } = queueing()
    const main = github.refs.get("main")
    const { writeId } = await merging(github, seen)
    const ran = await run(github, writeId)
    expect(ran.exit).toEqual(Exit.succeed({ status: "done", mergeSha: null }))
    const [request, ...others] = requests(github, seen.number)
    expect(others).toEqual([])
    expect(request!.login).toBe("maya")
    expect(request!.body).toContain(queueMarkerOf(seen.headSha))
    // The key the merge commit would carry, as the comment's write marker: a lost answer is found by it.
    expect(request!.body).toContain(`<!-- smithers:write=${Merge.mergeKeyOf(writeId)} -->`)
    expect([github.pulls.get(seen.number)!.merged, github.refs.get("main")]).toEqual([false, main])
    expect(github.seen("PUT", /\/merge$/)).toHaveLength(0)
    // The App read the file with only Contents: read, at the base the page showed.
    expect(github.seen("GET", /\/contents\//).map((call) => call.token)).toEqual(["installation"])
    expect(github.seen("POST", /\/comments$/).map((call) => call.token)).toEqual(["user"])
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done", itemNumber: seen.number, mergeFlow: "queue" })
  })

  test("a request whose answer was lost is found by its key: one comment", async () => {
    const { github, seen } = queueing()
    const { writeId } = await merging(github, seen)
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/comments"), lost: true })
    const ran = await run(github, writeId)
    expect(ran.exit).toEqual(Exit.succeed({ status: "done", mergeSha: null }))
    expect(requests(github, seen.number)).toHaveLength(1)
    expect(github.seen("POST", /\/comments$/)).toHaveLength(1)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done", mergeFlow: "queue" })
  })

  /** What changes on GitHub after the person saw the pull request. */
  type Change = (github: ScriptedGitHub, number: number) => void
  test.each<readonly [string, Change]>([
    ["head_moved", (github) => void github.push("smithers/t1-readme", { "B.md": "b\n" })],
    ["merged", (github, number) => void github.merge(number)],
    ["closed", (github, number) => github.close(number)],
    ["draft", (github, number) => void github.pulls.set(number, { ...github.pulls.get(number)!, draft: true })],
  ])("refuses %s: no request posted, the write settled refused", async (failure, change) => {
    const { github, seen } = queueing()
    const { writeId } = await merging(github, seen)
    change(github, seen.number)
    const ran = await run(github, writeId)
    expect(ran.exit).toEqual(Exit.succeed({ status: "refused", mergeSha: null }))
    expect(requests(github, seen.number)).toEqual([])
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure })
  })

  test("a moved base is no refusal for a queue: the queue lands the head on main as it then is", async () => {
    const { github, seen } = queueing()
    github.push("main", { "C.md": "c\n" })
    const { writeId } = await merging(github, seen)
    await run(github, writeId)
    expect(requests(github, seen.number)).toHaveLength(1)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done", mergeFlow: "queue" })
  })

  test("the file is read at the base the person saw: a pull request can't choose its own merge flow", async () => {
    const { github } = queueing()
    // The pull request itself says GitHub's merge; main, its base, says the queue.
    const baseSha = github.refs.get("main")!
    const headSha = github.push("smithers/t1-readme", { [MERGE_FLOW_FILE]: `{ "flow": "github" }\n` })
    const pull = github.openPull("smithers/t1-readme", "T1: flow", BOT_LOGIN)
    const { writeId } = await merging(github, { number: pull.number, headSha, baseSha })
    await run(github, writeId)
    expect(requests(github, pull.number)).toHaveLength(1)
    expect(github.pulls.get(pull.number)!.merged).toBe(false)
  })

  test("a page that saw a base without the file binds GitHub's merge, so its moved base is refused, not queued", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const older = opened(github)
    github.push("main", { [MERGE_FLOW_FILE]: `{ "flow": "queue" }\n` })
    const { writeId } = await merging(github, older)
    await run(github, writeId)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "base_moved" })
    expect(github.seen("POST", /\/comments$/)).toHaveLength(0)
  })

  test.each([
    ["not JSON", "flow: queue\n"],
    ["an unknown flow", `{ "flow": "rebase-train" }`],
    ["an unknown field", `{ "flow": "queue", "who": "member" }`],
  ])("a file that says %s is refused invalid: never a direct merge, never a request", async (_, text) => {
    const { github, seen } = queueing(text)
    const main = github.refs.get("main")
    const { writeId } = await merging(github, seen)
    await run(github, writeId)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "invalid" })
    expect([github.refs.get("main"), requests(github, seen.number)]).toEqual([main, []])
  })

  test("a file GitHub can't read now is tried again, never read as the default; then the request goes", async () => {
    const { github, seen } = queueing()
    const { writeId } = await merging(github, seen)
    const { services: built } = await services(runtime, github)
    github.faults.push({ match: (method, path) => method === "GET" && path.includes("/contents/"), status: 502 })
    const first = await runtime.runPromise(Effect.exit(Merge.steps(built).send({ writeId })))
    expect(Exit.isFailure(first) && Cause.squash(first.cause)).toBeInstanceOf(Merge.MergeUnavailable)
    expect([github.seen("PUT", /\/merge$/), requests(github, seen.number)]).toEqual([[], []])
    expect(await runtime.runPromise(Merge.steps(built).send({ writeId }))).toEqual({ status: "done", mergeSha: null })
    expect(requests(github, seen.number)).toHaveLength(1)
  })

  test("an App without Contents: read is refused not_allowed: the flow can't be known, so nothing is sent", async () => {
    const { github, seen } = queueing()
    github.contentsGranted = false
    const { writeId } = await merging(github, seen)
    await run(github, writeId)
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })
    expect([github.seen("PUT", /\/merge$/), requests(github, seen.number)]).toEqual([[], []])
  })

  test("`mergeFlowOf` reads the file's one field", () => {
    expect([`{"flow":"queue"}`, `{"flow":"github"}`, `{}`, `[]`, ``].map((text) => Option.getOrUndefined(Merge.mergeFlowOf(text))))
      .toEqual(["queue", "github", undefined, undefined, undefined])
  })
})
