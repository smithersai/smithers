// Issue triage (worker/github/{Triage,TriageStore,Write,Api}.ts, docs/features/issues.md#triage, decision 0012 §5) on
// the Node host (worker/test/flowHost.ts), over this file's schema of the compose Postgres and Electric (`pnpm db:up`),
// with the scripted GitHub (worker/github/test/scriptedGitHub.ts). The judge is a scripted model behind the model
// endpoint's own admission and metering (`ModelEndpoint.local`): the model is the only scripted seam. Faults are the
// scripted GitHub's armed answers and the judge's scripts; nothing intercepts a request.
import { FlowRuntime } from "@smthrs/flow"
import { ModelError } from "@smthrs/model"
import { Cause, Effect, Exit, Redacted, Stream } from "effect"
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import {
  ACCEPTED_LABEL,
  GITHUB_WEBHOOK_ROUTE,
  NOT_ACCEPTED_LABEL,
  TRIAGE_SETTINGS_SHAPE_ROUTE,
  triageRunExecutionId,
  writeExecutionId,
  writesRoute,
} from "../../src/features/issues/contract.ts"
import { NEEDS_REPRO_COMMENT, NEEDS_REPRO_LABEL } from "../../src/features/issues/lifecycle.ts"
import type * as Actor from "../Actor.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as Metrics from "./Metrics.ts"
import * as Reconcile from "./Reconcile.ts"
import {
  admit,
  items,
  judgeSeat,
  type JudgeAnswer,
  judging,
  REPOSITORY,
  reset,
  services,
  signedIn,
  sql,
  writeRow,
} from "./test/fixtures.ts"
import { delivery, githubHarness, member } from "./test/harness.ts"
import { BOT_LOGIN, scriptedGitHub } from "./test/scriptedGitHub.ts"
import { TokenUnavailable } from "./Tokens.ts"
import * as Triage from "./Triage.ts"
import * as TriageStore from "./TriageStore.ts"
import * as Write from "./Write.ts"

const runtime = testFile("github_triage")

beforeAll(async () => {
  const health = `${await runtime.runPromise(TestDatabase.electricUrl)}/v1/health`
  const response = await fetch(health).catch((error: unknown) => {
    throw TestDatabase.explain("Electric", new URL(health).host)(error)
  })
  if (!response.ok) throw new Error(`Electric answered ${response.status} to ${health}`)
})

beforeEach(() => reset(runtime))

test.each(["triage/enable", "triage/pause"] as const)("delayed %s refuses revoked admission and replay", async (op) => {
  const who = await signedIn(runtime, { login: "delayed-maintainer", token: Redacted.make("test-token") })
  await enable()
  const authority = { personId: who.personId, sessionId: who.sessionId, scope: { _tag: "Deployment" as const } }
  const payload = op === "triage/enable" ? { op, dailyTokens: 12345, authority } : { op, authority }
  const id = await admit(runtime, { actorId: who.personId, sessionId: who.sessionId, via: "person", payload })
  const before = await settings()
  await sql(runtime, `UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out' WHERE id = '${who.sessionId}'`)
  const host = await services(runtime, repository())
  const send = Write.steps(host.services).send({ writeId: id })
  expect(await runtime.runPromise(send)).toMatchObject({ status: "refused" })
  expect(await runtime.runPromise(send)).toMatchObject({ status: "refused" })
  expect(await settings()).toEqual(before)
})

test.each(["triage/enable", "triage/pause"].flatMap((op) => ["deployment", "repository"].map((scope) => [op, scope] as const)))(
  "queued %s refuses live-session %s demotion", async (op, scope) => {
    const who = await signedIn(runtime, { login: "demoted-maintainer", token: Redacted.make("test-token") })
    await sql(runtime, `UPDATE sessions SET role = 'maintainer', role_checked_at = clock_timestamp() WHERE id = '${who.sessionId}'`)
    await enable()
    const held = { repoId: REPOSITORY.id, personId: who.personId, role: "maintainer" as const }
    if (scope === "repository") await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
      VALUES ('${REPOSITORY.id}', '${who.personId}', 'maintainer', now())`)
    const authority = { personId: who.personId, sessionId: who.sessionId,
      scope: scope === "deployment" ? { _tag: "Deployment" as const } : { _tag: "Repo" as const, held } }
    const payload = op === "triage/enable" ? { op: "triage/enable" as const, dailyTokens: 12345, authority } : { op: "triage/pause" as const, authority }
    const id = await admit(runtime, { actorId: who.personId, sessionId: who.sessionId, via: "person", payload })
    const before = await settings()
    await sql(runtime, scope === "deployment"
      ? `UPDATE sessions SET role = 'member', role_checked_at = clock_timestamp() WHERE id = '${who.sessionId}'`
      : `UPDATE github_repo_roles SET role = 'member', checked_at = clock_timestamp() WHERE person_id = '${who.personId}'`)
    const host = await services(runtime, repository())
    const send = Write.steps(host.services).send({ writeId: id })
    expect(await runtime.runPromise(send)).toMatchObject({ status: "refused" })
    expect(await runtime.runPromise(send)).toMatchObject({ status: "refused" })
    expect(await settings()).toEqual(before)
  },
)

const REPO = `${REPOSITORY.owner}/${REPOSITORY.name}`

/** A sentinel no record may carry: titles, bodies, comments and logins are content. */
const SENTINEL = "sentinel-triage-91d4"

/** Sam, the Maintainer who enables triage; the flow acts under his role. */
const SAM = { id: "sam-id", login: "sam" }

/** Enables triage on the repository as Sam, with `dailyTokens` (the default unless set). */
const enable = (dailyTokens = 200_000, login: string | null = SAM.login) =>
  runtime.runPromise(TriageStore.enable(REPOSITORY.id, { actorId: SAM.id, login, dailyTokens }))

/** A scripted GitHub where Sam maintains the repository. */
const repository = () => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  github.roles.set(SAM.login, "maintain")
  return github
}

/** Every decision on the repository, oldest first. */
const decisions = async () =>
  (await sql(
    runtime,
    `SELECT via, number, decision, reason, abstained, tokens, decided_by AS "decidedBy",
      guidelines_sha AS "guidelinesSha", triage_before AS "triageBefore", labeled_at IS NOT NULL AS labeled,
      comment_github_id IS NOT NULL AS commented, comment_failed AS "commentFailed", dropped
    FROM triage_decisions WHERE repo_id = '${REPOSITORY.id}' ORDER BY created_at`,
  )) as unknown as Array<Record<string, unknown>>

/** The repository's settings row. */
const settings = async () =>
  ((await sql(runtime, `SELECT paused, paused_reason AS "pausedReason", daily_tokens AS "dailyTokens",
    enabled_by AS "enabledBy", enabled_login AS "enabledLogin" FROM triage_settings`)) as unknown as Array<
      Record<string, unknown>
    >)[0]

/** The projection's triage columns of issue `number`. */
const triageRow = async (number: number) =>
  ((await sql(runtime, `SELECT triage, triage_pinned AS pinned FROM items WHERE number = ${number}`)) as unknown as Array<{
    triage: string
    pinned: boolean
  }>)[0]

/** Runs `triage/Run` for issue `number` on the Node host, as `issues.opened` starts it. */
const triage = async (value: Triage.Services, number: number, key = crypto.randomUUID()) =>
  runFlow(Triage.TriageRun, { repo: REPO, number, trigger: "opened", key }, Triage.registration(value), {
    executionId: triageRunExecutionId(key),
    maxConnections: 3,
  })

/** Projects every issue GitHub has into `items`, as a reconcile walk does. */
const project = (value: Triage.Services) =>
  runFlow(Reconcile.Reconcile, { repo: REPO, requestedAtMs: Date.now() }, Reconcile.registration(value), { maxConnections: 2 })

/** The services over `github` with a judge that answers `answer`. */
const judged = async (github: ReturnType<typeof repository>, answer: JudgeAnswer, config?: Record<string, string>) => {
  const judge = await judgeSeat(runtime, answer, config === undefined ? {} : { config })
  const { services: value } = await services(runtime, github, { judge: judge.seat })
  return { value, seat: judge.seat, requests: judge.requests }
}

/** The text of a judge request's user message: the state the judge reads. */
const asked = (request: { readonly messages: ReadonlyArray<{ readonly content: ReadonlyArray<unknown> }> }) =>
  JSON.stringify(request.messages)

/** The comments on issue `number` as GitHub has them: author and first line. */
const githubComments = (github: ReturnType<typeof repository>, number: number) =>
  github.issues.get(number)!.comments.map((comment) => ({ login: comment.login, body: comment.body }))

describe("triage/Run", () => {
  test("a bug without code asks for a reproduction once across independent runs, without calling the judge", async () => {
    const github = repository()
    await enable()
    github.open("[bug] Crash", "Steps: open, submit.")
    const { value, requests } = await judged(github, judging("accept"))
    for (let i = 0; i < 2; i++) {
      expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "skipped", decisionId: null }))
    }
    expect(github.issues.get(1)!.labels).toEqual([NEEDS_REPRO_LABEL])
    expect(githubComments(github, 1)).toEqual([{ login: BOT_LOGIN, body: expect.stringContaining(NEEDS_REPRO_COMMENT) }])
    github.open("[bug] Empty reproduction", "```ts\n```\nSome prose\n```")
    expect((await triage(value, 2)).exit).toEqual(Exit.succeed({ outcome: "skipped", decisionId: null }))
    expect(github.issues.get(2)!.labels).toEqual([NEEDS_REPRO_LABEL])
    expect(githubComments(github, 2)).toEqual([{ login: BOT_LOGIN, body: expect.stringContaining(NEEDS_REPRO_COMMENT) }])
    expect(requests).toHaveLength(0)
    expect(await decisions()).toEqual([])
  })

  test.each(["permission", "demoted"])("missing reproduction cannot write after %s loss", async (loss) => {
    const github = repository()
    await enable()
    github.open("[bug] Crash", "No code")
    if (loss === "permission") github.granted = "read"
    else github.roles.set(SAM.login, "write")
    const { value, requests } = await judged(github, judging("accept"))
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "skipped", decisionId: null }))
    expect(github.issues.get(1)!.labels).toEqual([])
    expect(githubComments(github, 1)).toEqual([])
    expect(requests).toHaveLength(0)
    if (loss === "demoted") expect(await settings()).toMatchObject({ paused: true, pausedReason: "enabler_demoted" })
  })

  test.each(["snippet", "not_bug", "gone"])("rechecks the missing reproduction before publication: %s", async (change) => {
    const github = repository()
    await enable()
    github.open("[bug] Crash", "No code")
    let reads = 0
    github.faults.push({ match: (method, path) => {
      if (method === "GET" && /\/issues\/1$/.test(path) && ++reads === 2) {
        if (change === "snippet") github.comment(1, "```sh\nfalse\n```", "reporter")
        else if (change === "not_bug") github.retitle(1, "An improvement")
        else github.remove(1)
      }
      return false
    } })
    const { value, requests } = await judged(github, judging("accept"))
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "skipped", decisionId: null }))
    expect(github.issues.get(1)!.labels).toEqual([])
    expect(githubComments(github, 1).filter((comment) => comment.body.includes(NEEDS_REPRO_COMMENT))).toEqual([])
    expect(requests).toHaveLength(0)
  })

  test("an incomplete conversation cannot prove the repro request was never posted", async () => {
    const github = repository()
    await enable()
    github.open("[bug] Crash", "No code")
    for (let index = 0; index <= 1_000; index++) github.comment(1, "Still investigating", "reporter")
    const { value, requests } = await judged(github, judging("accept"))
    const exit = await Effect.runPromiseExit(Triage.steps(value).read({ repo: REPO, number: 1, trigger: "opened", key: "k" }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, { executionId: "e" } as never),
    ))
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(Triage.TriageUnavailable)
    expect(github.issues.get(1)!.labels).toEqual([NEEDS_REPRO_LABEL])
    expect(githubComments(github, 1).filter((comment) => comment.body.includes(NEEDS_REPRO_COMMENT))).toEqual([])
    expect(requests).toHaveLength(0)
  })

  test("a null issue body and deleted comment text still need a reproduction", async () => {
    const github = repository()
    await enable()
    github.open("[bug] Crash", null)
    Object.assign(github.comment(1, "", null), { body: null })
    const { value, requests } = await judged(github, judging("accept"))
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "skipped", decisionId: null }))
    expect(github.issues.get(1)!.labels).toEqual([NEEDS_REPRO_LABEL])
    expect(githubComments(github, 1).filter((comment) => comment.login === BOT_LOGIN))
      .toEqual([{ login: BOT_LOGIN, body: expect.stringContaining(NEEDS_REPRO_COMMENT) }])
    expect(requests).toHaveLength(0)
  })

  test.each(["permission", "demoted"])("a candidate cannot clear the repro label after %s loss", async (loss) => {
    const github = repository()
    await enable()
    github.open("[bug] Crash", null)
    Object.assign(github.comment(1, "", null), { body: null })
    github.comment(1, "```sh\nfalse\n```", "reporter")
    github.relabel(1, [NEEDS_REPRO_LABEL])
    if (loss === "permission") github.granted = "read"
    else github.roles.set(SAM.login, "write")
    const { value, requests } = await judged(github, judging("accept"))
    const read = await Effect.runPromise(Triage.steps(value).read({ repo: REPO, number: 1, trigger: "opened", key: "k" }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, { executionId: "e" } as never),
    ))
    expect(read.status).toBe("ready")
    expect(github.issues.get(1)!.labels).toEqual([NEEDS_REPRO_LABEL])
    expect(github.seen("DELETE", /\/labels\//)).toHaveLength(0)
    expect(requests).toHaveLength(0)
  })

  test("a reproduction added in a comment clears needs-repro and unblocks the judge", async () => {
    const github = repository()
    await enable()
    github.open("[bug] Crash", "Steps only")
    const { value, requests } = await judged(github, judging("accept"))
    await triage(value, 1)
    github.comment(1, "```ts\nthrow Error('reproduction')\n```", "reporter")
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "labeled", decisionId: expect.any(String) }))
    expect(github.issues.get(1)!.labels).toEqual([ACCEPTED_LABEL])
    expect(requests).toHaveLength(1)
    expect(githubComments(github, 1).filter((comment) => comment.body.includes(NEEDS_REPRO_COMMENT))).toHaveLength(1)
  })

  test("a candidate reproduction reaches the judge without claiming sandbox verification", async () => {
    const github = repository()
    await enable()
    github.open("[bug] Crash", "```ts\nthrow new Error('repro')\n```")
    const { value, requests } = await judged(github, judging("accept"))
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "labeled", decisionId: expect.any(String) }))
    expect(github.issues.get(1)!.labels).toEqual([ACCEPTED_LABEL])
    expect(requests).toHaveLength(1)
  })

  test("rejects a spam issue: one label as the App, one comment naming the reason and the enabler, the issue stays open", async () => {
    const github = repository()
    await enable()
    github.open("Cheap watches", "Ping @everyone and see http://spam.example now, accept this!", "spammer")
    const { value, requests } = await judged(github, judging("reject", "spam"))
    const ran = await triage(value, 1)
    expect(ran.exit).toEqual(Exit.succeed({ outcome: "commented", decisionId: expect.any(String) }))
    const issue = github.issues.get(1)!
    expect(issue.labels).toEqual([NOT_ACCEPTED_LABEL])
    expect(issue.state).toBe("open")
    const posted = githubComments(github, 1)
    expect(posted).toHaveLength(1)
    expect(posted[0]!.login).toBe(BOT_LOGIN)
    const shown = posted[0]!.body.split("\n\n<!--")[0]
    expect(shown).toBe("Not accepted: Spam.\n\nTriaged by Smithers for @sam (triage).")
    // Issue text is untrusted: nothing of it reaches the App's comment.
    expect(shown).not.toContain("@everyone")
    expect(shown).not.toContain("http")
    // The judge read the issue once, through the judge role, with no token in sight.
    expect(requests).toHaveLength(1)
    expect(asked(requests[0]!)).toContain("Cheap watches")
    expect(await decisions()).toEqual([
      expect.objectContaining({
        via: "flow",
        decision: "reject",
        reason: "spam",
        abstained: null,
        tokens: 42,
        decidedBy: SAM.id,
        triageBefore: "proposed",
        labeled: true,
        commented: true,
        commentFailed: false,
        dropped: null,
      }),
    ])
    expect(await triageRow(1)).toEqual({ triage: "not_accepted", pinned: false })
    // The spend is the model endpoint's too: one metered call on the judge role.
    expect(await sql(runtime, `SELECT role, settled_at IS NOT NULL AS settled FROM model_usage`)).toEqual([
      { role: "judge", settled: true },
    ])
  })

  test("accepts: the accepted label only, no comment; the same run again after its journal was lost writes nothing twice", async () => {
    const github = repository()
    await enable()
    github.open("Crash when the body is empty", "Steps: open, submit.")
    const { value, requests } = await judged(github, judging("accept"))
    const key = crypto.randomUUID()
    expect((await triage(value, 1, key)).exit).toEqual(Exit.succeed({ outcome: "labeled", decisionId: expect.any(String) }))
    expect(asked(requests[0]!)).toContain("accept this issue for discussion")
    expect(asked(requests[0]!)).toContain("Acceptance makes no commitment")
    expect(github.issues.get(1)!.labels).toEqual([ACCEPTED_LABEL])
    expect(github.issues.get(1)!.comments).toEqual([])
    // GitHub had no such label: the App made it, in green.
    expect(github.labels.get(ACCEPTED_LABEL)).toEqual({ name: ACCEPTED_LABEL, color: "0e8a16" })
    expect(await triageRow(1)).toEqual({ triage: "accepted", pinned: false })
    // A fresh engine runs the same execution again, as after a crash that lost its journal: the decision is the same
    // row, so its label receipt stops a second write.
    const labelWrites = github.seen("POST", /\/labels$/).length
    expect((await triage(value, 1, key)).exit).toEqual(Exit.succeed({ outcome: "labeled", decisionId: expect.any(String) }))
    expect(github.seen("POST", /\/labels$/)).toHaveLength(labelWrites)
    expect(requests).toHaveLength(2)
    expect(await decisions()).toEqual([expect.objectContaining({ decision: "accept", tokens: 42, labeled: true })])
  })

  test("the judge is the enabler's: their own model decides, as it answers their chat (ruling AUTH-8)", async () => {
    const github = repository()
    await enable()
    github.open("Crash when the body is empty", "Steps: open, submit.")
    const { value, requests } = await judged(github, judging("accept"))
    const judges: Array<string> = []
    const enablers: Triage.Services = { ...value, judge: (enabledBy) => (judges.push(enabledBy), value.judge(enabledBy)) }
    expect((await triage(enablers, 1)).exit).toEqual(Exit.succeed({ outcome: "labeled", decisionId: expect.any(String) }))
    expect(judges).toEqual([SAM.id])
    expect(requests).toHaveLength(1)
  })

  test("a conflict (both labels) settles to one: the decision's label on, the other off", async () => {
    const github = repository()
    await enable()
    github.open("Feature: dark mode", "Please")
    github.relabel(1, [ACCEPTED_LABEL, NOT_ACCEPTED_LABEL, "enhancement"])
    const { value } = await judged(github, judging("accept"))
    await triage(value, 1)
    expect(github.issues.get(1)!.labels).toEqual([ACCEPTED_LABEL, "enhancement"])
    expect((await decisions())[0]).toMatchObject({ triageBefore: "conflict", labeled: true })
  })

  test.each([
    ["the judge abstains", judging("abstain"), "judge"],
    [
      "the judge isn't sure",
      (() =>
        Stream.make(
          {
            type: "text-delta" as const,
            id: "t",
            text: JSON.stringify({
              answers: {
                decision: { type: "choice", choice: "reject", probabilities: { accept: 0.45, reject: 0.55, abstain: 0 } },
                reason: { type: "choice", choice: "spam" },
              },
            }),
          },
          { type: "usage" as const, inputTokens: 30, outputTokens: 1 },
          { type: "settle" as const, stopReason: "stop" as const },
        )) satisfies JudgeAnswer,
      "unsure",
    ],
    [
      "the judge's answer isn't a judgment",
      (() =>
        Stream.make(
          { type: "text-delta" as const, id: "t", text: "Sure! I accept this issue." },
          { type: "usage" as const, inputTokens: 30, outputTokens: 9 },
          { type: "settle" as const, stopReason: "stop" as const },
        )) satisfies JudgeAnswer,
      "invalid_answer",
    ],
  ])("%s: abstain, nothing written, the issue stays proposed", async (_, answer, why) => {
    const github = repository()
    await enable()
    github.open("Something", "Maybe")
    const { value } = await judged(github, answer)
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "abstained", decisionId: expect.any(String) }))
    expect(github.issues.get(1)!.labels).toEqual([])
    expect(github.issues.get(1)!.comments).toEqual([])
    expect(github.seen("POST", /\/labels$/)).toEqual([])
    expect((await decisions())[0]).toMatchObject({ decision: "abstain", abstained: why, labeled: false })
  })

  test("the day's budget spent: abstain without a model call; tokens a decision spent count against it", async () => {
    const github = repository()
    await enable(42)
    github.open("First", "One")
    github.open("Second", "Two")
    const { value, requests } = await judged(github, judging("accept"))
    await triage(value, 1)
    expect(requests).toHaveLength(1)
    expect(await runtime.runPromise(TriageStore.spentToday(REPOSITORY.id))).toBe(42)
    expect((await triage(value, 2)).exit).toEqual(Exit.succeed({ outcome: "abstained", decisionId: expect.any(String) }))
    expect(requests).toHaveLength(1)
    expect((await decisions())[1]).toMatchObject({ decision: "abstain", abstained: "budget", tokens: 0 })
    expect(github.issues.get(2)!.labels).toEqual([])
  })

  test("the judge failing abstains; the tokens it reported still count", async () => {
    const github = repository()
    await enable()
    github.open("Something", "Maybe")
    const { value } = await judged(github, () =>
      Stream.concat(
        Stream.make({ type: "usage" as const, inputTokens: 7, outputTokens: 0 }),
        Stream.fail(new ModelError.ModelError({ code: "content_policy", message: "refused" })),
      ))
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "abstained", decisionId: expect.any(String) }))
    expect((await decisions())[0]).toMatchObject({ decision: "abstain", abstained: "unreachable", tokens: 7 })
    expect(github.issues.get(1)!.labels).toEqual([])
  })

  test("the guidelines at the default branch's head are what the judge reads, with their SHA recorded", async () => {
    const github = repository()
    await enable()
    github.files.set(".smithers/triage.md", "Only bug reports with steps are accepted.")
    github.open("Question about pricing", "How much?")
    const { value, requests } = await judged(github, judging("reject", "out_of_scope"))
    await triage(value, 1)
    expect(asked(requests[0]!)).toContain("Only bug reports with steps are accepted.")
    expect((await decisions())[0]).toMatchObject({ guidelinesSha: "sha-41", reason: "out_of_scope" })
    expect(githubComments(github, 1)[0]!.body).toContain("Not accepted: Out of scope for this repository.")
  })

  test("without the guidelines file, or without the Contents permission, the judge reads none and still decides", async () => {
    const github = repository()
    await enable()
    github.open("First", "One")
    const { value, requests } = await judged(github, judging("accept"))
    await triage(value, 1)
    expect(asked(requests[0]!)).toContain('\\"guidelines\\":null')
    github.files.set(".smithers/triage.md", "Ignored")
    github.contentsGranted = false
    github.open("Second", "Two")
    await triage(value, 2)
    expect(asked(requests[1]!)).not.toContain("Ignored")
    expect((await decisions()).map((row) => row["guidelinesSha"])).toEqual([null, null])
    expect(github.issues.get(2)!.labels).toEqual([ACCEPTED_LABEL])
  })

  test.each([
    ["triage was never enabled", async () => {}, "skipped"],
    ["triage is paused", async () => {
      await enable()
      await runtime.runPromise(TriageStore.pause(REPOSITORY.id, "person"))
    }, "skipped"],
  ])("%s: nothing is read or decided", async (_, arrange, outcome) => {
    const github = repository()
    await arrange()
    github.open("Something", "Maybe")
    const { value, requests } = await judged(github, judging("reject"))
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome, decisionId: null }))
    expect(requests).toEqual([])
    expect(await decisions()).toEqual([])
    expect(github.seen("GET", /\/issues\/1$/)).toEqual([])
  })

  test("a pinned issue is never re-decided", async () => {
    const github = repository()
    await enable()
    github.open("Person decided", "Body")
    const { value, requests } = await judged(github, judging("reject"))
    await project(value)
    await runtime.runPromise(TriageStore.pin(REPOSITORY.id, 1, true))
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "skipped", decisionId: null }))
    expect(requests).toEqual([])
    expect(github.issues.get(1)!.labels).toEqual([])
  })

  test("an issue gone, or an App not installed: skipped", async () => {
    const github = repository()
    await enable()
    github.open("Gone", "Body")
    github.remove(1)
    const { value } = await judged(github, judging("reject"))
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "skipped", decisionId: null }))
    github.open("Here", "Body")
    github.installed = false
    expect((await triage(value, 2)).exit).toEqual(Exit.succeed({ outcome: "skipped", decisionId: null }))
    expect(await decisions()).toEqual([])
  })

  test.each([
    ["a person pins it (Accept or Not accepted)", "pinned", "pinned"],
    ["a person relabels it on GitHub", "relabeled", "relabeled"],
    ["someone edits its body", "edited", "edited"],
    ["triage is paused", "paused", "paused"],
    ["triage's settings are gone", "removed", "off"],
    ["the App is uninstalled", "uninstalled", "off"],
    ["it is deleted", "gone", "gone"],
    ["GitHub answers 410 for it", "gone410", "gone"],
    ["GitHub refuses to show it (403)", "hidden", "refused"],
  ] as const)("while the judge decides, %s: the decision is dropped, nothing written, recorded why", async (_, what, why) => {
    const github = repository()
    await enable()
    github.open("In flight", "Body")
    const { services: base } = await services(runtime, github)
    await project(base)
    const meanwhile: () => Promise<unknown> = {
      pinned: () => sql(runtime, `UPDATE items SET triage_pinned = true WHERE number = 1`),
      relabeled: async () => github.relabel(1, [ACCEPTED_LABEL]),
      edited: async () => {
        github.issues.get(1)!.body = "Edited"
        github.issues.get(1)!.updatedAt = Date.now() + 5_000
      },
      paused: () => runtime.runPromise(TriageStore.pause(REPOSITORY.id, "person")),
      removed: () => sql(runtime, `DELETE FROM triage_settings`),
      uninstalled: async () => {
        github.installed = false
        await sql(runtime, `UPDATE github_repositories SET installation_id = NULL`)
      },
      gone: async () => github.remove(1),
      gone410: async () =>
        void github.faults.push({ match: (method, path) => method === "GET" && /\/issues\/1$/.test(path), status: 410 }),
      hidden: async () =>
        void github.faults.push({ match: (method, path) => method === "GET" && /\/issues\/1$/.test(path), status: 403 }),
    }[what]
    const { value } = await judged(github, (request) =>
      Stream.unwrap(Effect.promise(meanwhile).pipe(Effect.as(judging("reject")(request)))))
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "dropped", decisionId: expect.any(String) }))
    expect(github.seen("POST", /\/labels$/)).toEqual([])
    expect(github.issues.get(1)!.comments).toEqual([])
    expect((await decisions())[0]).toMatchObject({ decision: "reject", labeled: false, dropped: why })
  })

  test("the enabler is no longer a Maintainer: refused, triage pauses, an error is logged", async () => {
    const github = repository()
    await enable()
    github.roles.set(SAM.login, "write")
    github.open("Spam", "Body")
    const { value } = await judged(github, judging("reject", "spam"))
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "dropped", decisionId: expect.any(String) }))
    expect(github.issues.get(1)!.labels).toEqual([])
    expect((await decisions())[0]).toMatchObject({ dropped: "enabler_demoted" })
    expect(await settings()).toMatchObject({ paused: true, pausedReason: "enabler_demoted" })
    // The next new issue isn't decided at all.
    github.open("Next", "Body")
    expect((await triage(value, 2)).exit).toEqual(Exit.succeed({ outcome: "skipped", decisionId: null }))
  })

  test("an enabler GitHub no longer lists, or one with no login, is no Maintainer either", async () => {
    const github = repository()
    await enable(200_000, null)
    github.open("Spam", "Body")
    const { value } = await judged(github, judging("reject"))
    await triage(value, 1)
    expect((await decisions())[0]).toMatchObject({ dropped: "enabler_demoted" })
    await enable()
    github.roles.delete(SAM.login)
    github.open("More", "Body")
    await triage(value, 2)
    expect((await decisions())[1]).toMatchObject({ dropped: "enabler_demoted" })
  })

  test("GitHub refusing the label drops the decision without trying again", async () => {
    const github = repository()
    await enable()
    github.open("Spam", "Body")
    github.faults.push({ match: (method, path) => method === "POST" && /\/issues\/1\/labels$/.test(path), status: 403 })
    const { value } = await judged(github, judging("reject"))
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "dropped", decisionId: expect.any(String) }))
    expect((await decisions())[0]).toMatchObject({ dropped: "refused", labeled: false })
    expect(github.issues.get(1)!.comments).toEqual([])
  })

  test("the comment refused after the label: the label receipt stands, the comment is recorded failed", async () => {
    const github = repository()
    await enable()
    github.open("Spam", "Body")
    github.faults.push({ match: (method, path) => method === "POST" && /\/comments$/.test(path), status: 403 })
    const { value } = await judged(github, judging("reject", "spam"))
    expect((await triage(value, 1)).exit).toEqual(
      Exit.succeed({ outcome: "comment_failed", decisionId: expect.any(String) }),
    )
    expect(github.issues.get(1)!.labels).toEqual([NOT_ACCEPTED_LABEL])
    expect((await decisions())[0]).toMatchObject({ labeled: true, commented: false, commentFailed: true })
  })

  test("the comment's answer lost: the next attempt finds its marker, so the author gets one comment", async () => {
    const github = repository()
    await enable()
    github.open("Spam", "Body")
    github.faults.push({ match: (method, path) => method === "POST" && /\/comments$/.test(path), lost: true })
    const { value } = await judged(github, judging("reject", "duplicate"))
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "commented", decisionId: expect.any(String) }))
    expect(githubComments(github, 1)).toHaveLength(1)
    expect((await decisions())[0]).toMatchObject({ commented: true, commentFailed: false })
  })

  test("the comment GitHub couldn't take for a moment is tried again: the author gets one comment", async () => {
    const github = repository()
    await enable()
    github.open("Spam", "Body")
    github.faults.push({ match: (method, path) => method === "POST" && /\/comments$/.test(path), status: 502 })
    const { value } = await judged(github, judging("reject", "duplicate"))
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "commented", decisionId: expect.any(String) }))
    expect(githubComments(github, 1)).toHaveLength(1)
    expect(github.seen("POST", /\/comments$/)).toHaveLength(2)
    expect((await decisions())[0]).toMatchObject({ commented: true, commentFailed: false })
  })

  // A window back from "now" missed a comment whose answer was lost once the run resumed later than the window
  // (91 minutes), and the author got a second one. The lookup reads the whole thread instead.
  test("the comment's answer lost and the run resumed hours later: the marker is still found, one comment", async () => {
    const github = repository()
    await enable()
    github.open("Spam", "Body")
    github.faults.push(
      { match: (method, path) => method === "POST" && /\/comments$/.test(path), lost: true },
      {
        // Every later read of the thread finds the lost comment two hours older, as a resume after a long outage does.
        match: (method, path) => {
          if (method === "GET" && /\/comments$/.test(path)) {
            for (const comment of github.issues.get(1)!.comments) comment.updatedAt -= 2 * 3_600_000
          }
          return false
        },
      },
    )
    const { value } = await judged(github, judging("reject", "duplicate"))
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "commented", decisionId: expect.any(String) }))
    expect(githubComments(github, 1)).toHaveLength(1)
  })

  test("the comment failing past its retries: recorded failed, the label stands", async () => {
    const github = repository()
    await enable()
    github.open("Spam", "Body")
    const { value } = await judged(github, judging("reject"))
    const labeled = await Effect.runPromise(
      Triage.steps(value).commentFailed({
        labeled: {
          status: "labeled",
          decisionId: "00000000-0000-5000-8000-000000000001",
          repo: REPO,
          number: 1,
          decision: "reject",
          reason: "spam",
          enabledLogin: SAM.login,
          inputDigest: "",
          triage: "proposed",
        },
      }),
    )
    expect(labeled).toEqual({ outcome: "comment_failed", decisionId: "00000000-0000-5000-8000-000000000001" })
    expect(
      await Effect.runPromise(Triage.steps(value).commentFailed({ labeled: { status: "skipped", why: "off" } })),
    ).toEqual({ outcome: "comment_failed", decisionId: null })
  })

  test("GitHub unavailable while reading: the run ends unavailable and writes nothing", async () => {
    const github = repository()
    await enable()
    github.open("Spam", "Body")
    const { value } = await judged(github, judging("reject"))
    // A faulty token service: GitHub can't mint a token now.
    const failing = Triage.steps({
      ...value,
      tokens: {
        ...value.tokens,
        forInstallation: () => Effect.fail(new TokenUnavailable({ reason: "unavailable", retryAfterMillis: 2_000 })),
      },
    })
    const exit = await Effect.runPromiseExit(
      failing.read({ repo: REPO, number: 1, trigger: "opened", key: "k" }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, { executionId: "e" } as never),
      ),
    )
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(new Triage.TriageUnavailable({ retryAfterMillis: 2_000 }))
    const unhinted = Triage.steps({
      ...value,
      tokens: { ...value.tokens, forInstallation: () => Effect.fail(new TokenUnavailable({ reason: "unavailable" })) },
    })
    const again = await Effect.runPromiseExit(
      unhinted.read({ repo: REPO, number: 1, trigger: "opened", key: "k" }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, { executionId: "e" } as never),
      ),
    )
    expect(Exit.isFailure(again) && Cause.squash(again.cause)).toEqual(new Triage.TriageUnavailable({}))
    expect(await decisions()).toEqual([])
  })

  test("what the judge reads is bounded: the body and guidelines cut short, the last comments only, a ghost's as nobody", async () => {
    const github = repository()
    await enable()
    github.files.set(".smithers/triage.md", `${"g".repeat(8_000)}TAIL-OF-GUIDELINES`)
    github.open("Long one", `${"b".repeat(8_000)}TAIL-OF-BODY`)
    for (let at = 0; at < 22; at++) github.comment(1, at === 21 ? `${"c".repeat(2_000)}TAIL-OF-COMMENT` : `comment ${at}`, at === 20 ? null : "ben")
    github.open("No description", null)
    const { value, requests } = await judged(github, judging("accept"))
    await triage(value, 1)
    const state = asked(requests[0]!)
    expect(state).not.toContain("TAIL-OF-GUIDELINES")
    expect(state).not.toContain("TAIL-OF-BODY")
    expect(state).not.toContain("TAIL-OF-COMMENT")
    expect(state).not.toContain("comment 1\\")
    expect(state).toContain("comment 2")
    expect(state).toContain('\\"author\\":\\"\\"')
    await triage(value, 2)
    expect(github.issues.get(2)!.labels).toEqual([ACCEPTED_LABEL])
  })

  test("a judge that reports no usage spends nothing it can count; one that fails at once, nothing either", async () => {
    const github = repository()
    await enable()
    github.open("First", "One")
    github.open("Second", "Two")
    const { value } = await judged(github, (request) =>
      Stream.filter(judging("accept")(request), (event) => event.type !== "usage"))
    await triage(value, 1)
    const failing = await judged(github, () => Stream.fail(new ModelError.ModelError({ code: "content_policy", message: "no" })))
    await triage(failing.value, 2)
    expect((await decisions()).map((row) => [row["decision"], row["tokens"]])).toEqual([["accept", 0], ["abstain", 0]])
  })

  test("GitHub slow or briefly failing: reads and labels are tried again, waiting what GitHub asks", async () => {
    const github = repository()
    await enable()
    github.open("Spam", "Body")
    github.faults.push(
      { match: (method, path) => method === "GET" && /\/issues\/1$/.test(path), status: 429, headers: { "retry-after": "1" } },
      { match: (method, path) => method === "GET" && /\/issues\/1\/comments$/.test(path), status: 502 },
    )
    const { value } = await judged(github, (request) =>
      Stream.unwrap(Effect.sync(() => {
        // Between the decision and the label, GitHub fails the label once.
        github.faults.push({ match: (method, path) => method === "POST" && /\/issues\/1\/labels$/.test(path), status: 502 })
        return judging("accept")(request)
      })))
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "labeled", decisionId: expect.any(String) }))
    expect(github.issues.get(1)!.labels).toEqual([ACCEPTED_LABEL])
  }, 60_000)

  test("the same run again after its journal was lost: a dropped decision stays dropped; a posted comment isn't posted twice", async () => {
    const github = repository()
    await enable()
    github.open("Relabeled", "```ts\nthrow Error()\n```")
    github.open("Spam", "Body")
    const { services: base } = await services(runtime, github)
    await project(base)
    let relabel = true
    const { value } = await judged(github, (request) => {
      if (relabel) github.relabel(1, ["bug", ACCEPTED_LABEL])
      relabel = false
      return judging("reject", "spam")(request)
    })
    const first = crypto.randomUUID()
    expect((await triage(value, 1, first)).exit).toEqual(Exit.succeed({ outcome: "dropped", decisionId: expect.any(String) }))
    expect((await triage(value, 1, first)).exit).toEqual(Exit.succeed({ outcome: "dropped", decisionId: expect.any(String) }))
    expect(github.seen("POST", /\/issues\/1\/labels$/)).toEqual([])
    const second = crypto.randomUUID()
    await triage(value, 2, second)
    expect((await triage(value, 2, second)).exit).toEqual(Exit.succeed({ outcome: "commented", decisionId: expect.any(String) }))
    expect(githubComments(github, 2)).toHaveLength(1)
  })

  test("the enabler demoted between the label and the comment: no comment, triage pauses, the label stands", async () => {
    const github = repository()
    await enable()
    github.open("Spam", "Body")
    // GitHub demotes Sam the moment the label lands; the comment's own re-check sees it.
    github.faults.push({
      match: (method, path) => {
        if (method === "POST" && /\/issues\/1\/labels$/.test(path)) github.roles.set(SAM.login, "triage")
        return false
      },
    })
    const { value } = await judged(github, judging("reject", "spam"))
    expect((await triage(value, 1)).exit).toEqual(
      Exit.succeed({ outcome: "comment_failed", decisionId: expect.any(String) }),
    )
    expect(github.issues.get(1)!.labels).toEqual([NOT_ACCEPTED_LABEL])
    expect(github.issues.get(1)!.comments).toEqual([])
    expect((await decisions())[0]).toMatchObject({ labeled: true, commentFailed: true })
    expect(await settings()).toMatchObject({ paused: true, pausedReason: "enabler_demoted" })
  })

  test("an enabler holding an organization's custom role counts by its base permission", async () => {
    const github = repository()
    await enable()
    github.roles.set(SAM.login, { roleName: "release-manager", permission: "admin" })
    github.open("Spam", "Body")
    const { value } = await judged(github, judging("reject", "spam"))
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "commented", decisionId: expect.any(String) }))
    github.roles.set(SAM.login, { roleName: "auditor", permission: "audit" })
    github.open("More", "Body")
    await triage(value, 2)
    expect((await decisions())[1]).toMatchObject({ dropped: "enabler_demoted" })
  })

  test("the App uninstalled between the label and the comment: the comment fails at once, the label stands", async () => {
    const github = repository()
    await enable()
    github.open("Spam", "Body")
    let mints = 0
    // The run mints four tokens: the read, the guidelines, the label and the comment. The fourth finds no App.
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/access_tokens") && ++mints === 4, status: 404 })
    const { value } = await judged(github, judging("reject", "spam"))
    expect((await triage(value, 1)).exit).toEqual(
      Exit.succeed({ outcome: "comment_failed", decisionId: expect.any(String) }),
    )
    expect(github.issues.get(1)!.labels).toEqual([NOT_ACCEPTED_LABEL])
    expect((await decisions())[0]).toMatchObject({ labeled: true, commentFailed: true })
  })

  test("no record carries a title, a body, a comment or a login", async () => {
    const github = repository()
    github.roles.set(SENTINEL, "maintain")
    await runtime.runPromise(TriageStore.enable(REPOSITORY.id, { actorId: SAM.id, login: SENTINEL, dailyTokens: 1_000 }))
    github.open(SENTINEL, SENTINEL, SENTINEL)
    github.comment(1, SENTINEL, SENTINEL)
    github.files.set(".smithers/triage.md", SENTINEL)
    const judge = await judgeSeat(runtime, judging("reject", "spam"))
    const h = await githubHarness(runtime, {
      actor: null,
      run: true,
      github,
      judge: judge.seat,
    })
    const response = await h.fetch(
      GITHUB_WEBHOOK_ROUTE,
      await delivery("issues", { action: "opened", repository: { full_name: REPO }, issue: { number: 1 } }),
    )
    expect(response.status).toBe(200)
    await h.settled()
    expect(github.issues.get(1)!.labels).toEqual([NOT_ACCEPTED_LABEL])
    const records = JSON.stringify([h.logs, h.spans.map((span) => [span.name, span.attributes]), h.snapshot()])
    expect(records).toContain("triage.decide")
    expect(records).not.toContain(SENTINEL)
  })
})

describe("the webhook", () => {
  const opened = (number: number) =>
    delivery("issues", { action: "opened", repository: { full_name: REPO }, issue: { number } })

  test("issues.opened while triage is on starts triage/Run once per delivery; while off, only the re-read", async () => {
    const h = await githubHarness(runtime, { actor: null })
    const off = await h.fetch(GITHUB_WEBHOOK_ROUTE, await opened(1))
    expect(off.status).toBe(200)
    expect(h.starts.map((start) => start.flow)).toEqual(["github/Apply"])
    await enable()
    const id = crypto.randomUUID()
    for (let sent = 0; sent < 2; sent++) {
      expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("issues", {
        action: "opened",
        repository: { full_name: REPO },
        issue: { number: 2 },
      }, { id }))).status).toBe(200)
    }
    // A redelivery starts the very same execution, which changes nothing.
    const start = {
      flow: "triage/Run",
      executionId: triageRunExecutionId(id),
      payload: { repo: REPO, number: 2, trigger: "opened", key: id },
    }
    expect(h.starts.filter((started) => started.flow === "triage/Run")).toEqual([start, start])
    // Edits and comments don't start triage; neither does a paused repository.
    await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("issues", { action: "edited", repository: { full_name: REPO }, issue: { number: 2 } }))
    await runtime.runPromise(TriageStore.pause(REPOSITORY.id, "person"))
    await h.fetch(GITHUB_WEBHOOK_ROUTE, await opened(3))
    expect(h.starts.filter((started) => started.flow === "triage/Run")).toHaveLength(2)
  })

  test("with every device closed, a new issue is triaged end to end: delivery, decision, label, comment, projection", async () => {
    const github = repository()
    await enable()
    github.open("Win a prize", "Click here")
    const judge = await judgeSeat(runtime, judging("reject", "spam"))
    const h = await githubHarness(runtime, { actor: null, run: true, github, judge: judge.seat })
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, await opened(1))).status).toBe(200)
    await h.settled()
    expect(github.issues.get(1)!.labels).toEqual([NOT_ACCEPTED_LABEL])
    expect(githubComments(github, 1)).toHaveLength(1)
    expect(await triageRow(1)).toEqual({ triage: "not_accepted", pinned: false })
    expect(h.count(Metrics.triageRuns, { outcome: "commented" })).toBe(1)
    expect(h.count(Metrics.triageDecisions, { decision: "reject", via: "flow" })).toBe(1)
  })
})

describe("a person's triage", () => {
  const post = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  /** Maya, signed in as `role` with a GitHub token the scripted GitHub takes. */
  const maya = async (github: ReturnType<typeof repository>, role: Actor.Actor["role"] = "member") => {
    const token = github.userToken("maya")
    const person = await signedIn(runtime, { login: "maya", token, role })
    return { ...person, actor: { ...member(person.personId, person.sessionId), role, login: "maya" } satisfies Actor.Actor }
  }

  test("a Maintainer sets every commitment on an accepted issue, replacing the previous GitHub label", async () => {
    const github = repository()
    github.open("Accepted for discussion", "Body")
    github.relabel(1, [ACCEPTED_LABEL, "unrelated"])
    const person = await maya(github, "maintainer")
    github.roles.set("maya", "maintain")
    const h = await githubHarness(runtime, { actor: person.actor, run: true, github })
    for (const commitment of ["now", "next", "later", "none"]) {
      const writeId = crypto.randomUUID()
      expect((await h.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post({ writeId, op: "issue/commitment", number: 1, commitment }))).status).toBe(202)
      await h.settled()
      expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done", itemNumber: 1 })
      expect(github.issues.get(1)!.labels).toEqual([ACCEPTED_LABEL, "unrelated", `smithers:commit-${commitment}`])
      expect(await sql(runtime, `SELECT commitment FROM items WHERE number = 1`)).toEqual([{ commitment }])
    }
    expect(githubComments(github, 1)).toHaveLength(0)
  })

  test("commitment refuses Members, demoted Maintainers, unaccepted issues and agent credentials", async () => {
    const github = repository()
    github.open("Still proposed", "Body")
    const person = await maya(github)
    const h = await githubHarness(runtime, { actor: person.actor, run: true, github })
    expect((await h.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post({ writeId: crypto.randomUUID(), op: "issue/commitment", number: 1, commitment: "now" }))).status).toBe(403)
    const writer = await githubHarness(runtime, { actor: { ...person.actor, role: "maintainer" }, run: true, github })
    for (const accepted of [false, true]) {
      github.relabel(1, accepted ? [ACCEPTED_LABEL] : [])
      github.roles.set("maya", accepted ? "write" : "maintain")
      const writeId = crypto.randomUUID()
      expect((await writer.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post({ writeId, op: "issue/commitment", number: 1, commitment: "now" }))).status).toBe(202)
      await writer.settled()
      expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })
      expect(github.issues.get(1)!.labels).toEqual(accepted ? [ACCEPTED_LABEL] : [])
    }
  })

  test("Not accepted with a reason: labels and comments as the person, pins the issue, records their decision", async () => {
    const github = repository()
    github.open("Flaky", "Sometimes")
    const person = await maya(github)
    const h = await githubHarness(runtime, { actor: person.actor, run: true, github })
    const { services: value } = await services(runtime, github)
    await project(value)
    const write = { writeId: crypto.randomUUID(), via: "person", op: "issue/triage", number: 1, decision: "reject", reason: "Duplicate of #3" }
    const answer = await h.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post(write))
    expect(answer.status).toBe(202)
    expect(h.starts).toEqual([
      { flow: "github/Write", executionId: writeExecutionId(write.writeId), payload: { writeId: write.writeId } },
    ])
    await h.settled()
    expect(await writeRow(runtime, write.writeId)).toMatchObject({ status: "done", itemNumber: 1 })
    expect(github.issues.get(1)!.labels).toEqual([NOT_ACCEPTED_LABEL])
    expect(githubComments(github, 1).map((comment) => [comment.login, comment.body.split("\n")[0]])).toEqual([
      ["maya", "Duplicate of #3"],
    ])
    expect(await triageRow(1)).toEqual({ triage: "not_accepted", pinned: true })
    expect(await decisions()).toEqual([
      expect.objectContaining({ via: "person", decision: "reject", decidedBy: person.personId, labeled: true, commented: true }),
    ])
    expect(h.count(Metrics.triageOverrides, { from: "proposed", to: "reject" })).toBe(1)
  })

  test("Accept without a reason only labels; overriding the flow's rejection swaps the label", async () => {
    const github = repository()
    await enable()
    github.open("Real bug", "Steps")
    const { value } = await judged(github, judging("reject", "spam"))
    await triage(value, 1)
    expect(github.issues.get(1)!.labels).toEqual([NOT_ACCEPTED_LABEL])
    const person = await maya(github)
    const h = await githubHarness(runtime, { actor: person.actor, run: true, github })
    const write = { writeId: crypto.randomUUID(), via: "person", op: "issue/triage", number: 1, decision: "accept" }
    expect((await h.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post(write))).status).toBe(202)
    await h.settled()
    expect(github.issues.get(1)!.labels).toEqual([ACCEPTED_LABEL])
    expect(githubComments(github, 1)).toHaveLength(1)
    expect(await triageRow(1)).toEqual({ triage: "accepted", pinned: true })
    expect(h.count(Metrics.triageOverrides, { from: "not_accepted", to: "accept" })).toBe(1)
  })

  test("a person's Accept wins over a flow label already past its checks, though the flow's request lands later", { timeout: 120_000 }, async () => {
    const github = repository()
    await enable()
    github.open("Real bug", "Steps")
    const { value } = await judged(github, judging("reject", "spam"))
    await project(value)
    const person = await maya(github)
    const h = await githubHarness(runtime, { actor: person.actor, run: true, github })
    const write = { writeId: crypto.randomUUID(), op: "issue/triage", number: 1, decision: "accept" }
    let personSettled: Promise<void> | undefined
    const waiting = () => h.line("github.write").some((line) => line.annotations["outcome"] === "waiting")
    // The flow passed its pin and label checks; its label request is still in flight at GitHub when Maya presses
    // Accept. GitHub takes the flow's request only once Maya's write settled, or said it waits for the flow's label.
    github.faults.push({
      match: (method, path) => method === "POST" && /\/issues\/1\/labels$/.test(path),
      hold: async () => {
        expect((await h.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post(write))).status).toBe(202)
        personSettled = h.settled()
        await Promise.race([personSettled, vi.waitFor(() => expect(waiting()).toBe(true), { timeout: 60_000, interval: 50 })])
      },
    })
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "labeled", decisionId: expect.any(String) }))
    await personSettled
    // Before 2026-10-21 Maya's labels landed first and the flow's overwrote them: the issue stayed not accepted.
    expect(await writeRow(runtime, write.writeId)).toMatchObject({ status: "done", itemNumber: 1 })
    expect(github.issues.get(1)!.labels).toEqual([ACCEPTED_LABEL])
    expect(await triageRow(1)).toEqual({ triage: "accepted", pinned: true })
    // The flow's reason is never posted under Maya's decision.
    expect(githubComments(github, 1)).toEqual([])
    expect(waiting()).toBe(true)
    expect(await decisions()).toEqual([
      expect.objectContaining({ via: "flow", decision: "reject", labeled: true, commented: false, commentFailed: false }),
      expect.objectContaining({ via: "person", decision: "accept", labeled: true }),
    ])
  })

  test("a person's write pins the issue from the moment it is admitted: the flow drops a decision it hadn't labeled", async () => {
    const github = repository()
    await enable()
    github.open("Real bug", "Steps")
    const { value, requests } = await judged(github, judging("reject", "spam"))
    await project(value)
    const person = await maya(github)
    // Admitted and not yet run: the write is pending.
    const h = await githubHarness(runtime, { actor: person.actor, github })
    const write = { writeId: crypto.randomUUID(), op: "issue/triage", number: 1, decision: "accept" }
    expect((await h.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post(write))).status).toBe(202)
    expect(await runtime.runPromise(TriageStore.itemTriage(REPOSITORY.id, 1))).toEqual(
      expect.objectContaining({ value: { triage: "proposed", pinned: true } }),
    )
    // Before 2026-10-21 nothing pinned the issue until the write settled, and the flow labeled it.
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "skipped", decisionId: null }))
    expect(requests).toEqual([])
    expect(github.issues.get(1)!.labels).toEqual([])
    // Settled, the write leaves its own pin; refused, it leaves none.
    await sql(runtime, `UPDATE github_writes SET status = 'refused', failure = 'not_allowed', settled_at = now() WHERE id = '${write.writeId}'`)
    expect(await runtime.runPromise(TriageStore.itemTriage(REPOSITORY.id, 1))).toEqual(
      expect.objectContaining({ value: { triage: "proposed", pinned: false } }),
    )
  })

  test("a person waits only for a flow write that started and hasn't finished, however long ago it was decided", async () => {
    const github = repository()
    github.open("Real bug", "Steps")
    const { services: value } = await services(runtime, github)
    await project(value)
    const inFlight = () => runtime.runPromise(TriageStore.flowWriteInFlight(REPOSITORY.id, 1))
    const decide = (id: string, decision: "reject" | "abstain") =>
      runtime.runPromise(TriageStore.recordDecision({
        id,
        repoId: REPOSITORY.id,
        number: 1,
        via: "flow",
        decidedBy: null,
        runId: null,
        writeId: null,
        guidelinesSha: null,
        inputDigest: null,
        triageBefore: "proposed",
        decision,
        reason: decision === "reject" ? "spam" : null,
        abstained: decision === "abstain" ? "judge" : null,
        tokens: 0,
      }))
    // Decided, but its label step hasn't started: when it does, it finds the pin.
    const id = crypto.randomUUID()
    await decide(id, "reject")
    await decide(crypto.randomUUID(), "abstain")
    expect(await inFlight()).toBe(false)
    // Decided 40 minutes ago, its label step starting now: in flight (before 2026-10-21 the decision's age ruled it out,
    // Codex Astra review).
    await sql(runtime, `UPDATE triage_decisions SET created_at = now() - interval '40 minutes' WHERE id = '${id}'`)
    await runtime.runPromise(TriageStore.startLabel(id))
    expect(await inFlight()).toBe(true)
    // A label step that started past its lease stopped for good.
    await sql(runtime, `UPDATE triage_decisions SET label_started_at = now() - interval '32 minutes' WHERE id = '${id}'`)
    expect(await inFlight()).toBe(false)
    await sql(runtime, `UPDATE triage_decisions SET label_started_at = now() WHERE id = '${id}'`)
    await runtime.runPromise(TriageStore.labeled(id))
    expect(await inFlight()).toBe(false)
    // Its rejection comment: in flight from its start until it is posted, failed or skipped.
    await runtime.runPromise(TriageStore.startComment(id))
    expect(await inFlight()).toBe(true)
    await runtime.runPromise(TriageStore.skipComment(id))
    expect(await inFlight()).toBe(false)
    await runtime.runPromise(TriageStore.startComment(id))
    await sql(runtime, `UPDATE triage_decisions SET comment_started_at = now() - interval '62 minutes' WHERE id = '${id}'`)
    expect(await inFlight()).toBe(false)
    await sql(runtime, `UPDATE triage_decisions SET comment_started_at = now() WHERE id = '${id}'`)
    await runtime.runPromise(TriageStore.commentFailed(id))
    expect(await inFlight()).toBe(false)
    await sql(runtime, `UPDATE triage_decisions SET comment_failed = false WHERE id = '${id}'`)
    await runtime.runPromise(TriageStore.commented(id, 77))
    expect(await inFlight()).toBe(false)
    // A dropped label step is done; a step that found the decision settled records no start.
    const dropped = crypto.randomUUID()
    await decide(dropped, "reject")
    await runtime.runPromise(TriageStore.startLabel(dropped))
    await runtime.runPromise(TriageStore.drop(dropped, "pinned"))
    expect(await inFlight()).toBe(false)
    await runtime.runPromise(TriageStore.startLabel(dropped))
    expect(await sql(runtime, `SELECT label_started_at IS NOT NULL AS started FROM triage_decisions WHERE id = '${dropped}'`))
      .toEqual([{ started: true }])
    // The leases cover each step's whole retry policy.
    expect(TriageStore.LABEL_LEASE_MS).toBeGreaterThan(Triage.TRIAGE_RETRY.expirationMs!)
    expect(TriageStore.COMMENT_LEASE_MS).toBeGreaterThan(Triage.COMMENT_RETRY.expirationMs!)
  })

  test("a person's Accept waits for a flow's rejection comment already past its checks, then labels last", { timeout: 120_000 }, async () => {
    const github = repository()
    await enable()
    github.open("Real bug", "Steps")
    const { value } = await judged(github, judging("reject", "spam"))
    await project(value)
    const person = await maya(github)
    const h = await githubHarness(runtime, { actor: person.actor, run: true, github })
    const write = { writeId: crypto.randomUUID(), op: "issue/triage", number: 1, decision: "accept" }
    let personSettled: Promise<void> | undefined
    const waiting = () => h.line("github.write").some((line) => line.annotations["outcome"] === "waiting")
    // The flow labeled, passed its comment's pin check, and its comment is in flight when Maya presses Accept.
    github.faults.push({
      match: (method, path) => method === "POST" && /\/issues\/1\/comments$/.test(path),
      hold: async () => {
        expect((await h.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post(write))).status).toBe(202)
        personSettled = h.settled()
        await Promise.race([personSettled, vi.waitFor(() => expect(waiting()).toBe(true), { timeout: 60_000, interval: 50 })])
      },
    })
    expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "commented", decisionId: expect.any(String) }))
    await personSettled
    // Before this, Maya's write saw the flow's decision labeled and went ahead while its comment was still to land.
    expect(waiting()).toBe(true)
    expect(await writeRow(runtime, write.writeId)).toMatchObject({ status: "done" })
    expect(github.issues.get(1)!.labels).toEqual([ACCEPTED_LABEL])
    expect(await triageRow(1)).toEqual({ triage: "accepted", pinned: true })
    expect(githubComments(github, 1)).toEqual([{ login: BOT_LOGIN, body: expect.stringContaining("Not accepted") }])
  })

  test("Run triage again: unpins the issue, settles the write and decides it again", async () => {
    const github = repository()
    await enable()
    github.open("Was pinned", "Body")
    const { value, seat, requests } = await judged(github, judging("accept"))
    await project(value)
    await runtime.runPromise(TriageStore.pin(REPOSITORY.id, 1, true))
    const person = await maya(github)
    const h = await githubHarness(runtime, { actor: person.actor, run: true, github, judge: seat })
    const write = { writeId: crypto.randomUUID(), via: "person", op: "triage/run", number: 1 }
    expect((await h.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post(write))).status).toBe(202)
    expect(h.starts).toEqual([
      {
        flow: "triage/Run",
        executionId: triageRunExecutionId(write.writeId),
        payload: { repo: REPO, number: 1, trigger: "again", key: write.writeId },
      },
    ])
    await h.settled()
    expect(await writeRow(runtime, write.writeId)).toMatchObject({ status: "done", itemNumber: 1 })
    expect(requests).toHaveLength(1)
    expect(github.issues.get(1)!.labels).toEqual([ACCEPTED_LABEL])
    expect(await triageRow(1)).toEqual({ triage: "accepted", pinned: false })
  })

  test("Run triage again while triage is off still unpins and settles: nothing is decided", async () => {
    const github = repository()
    github.open("Was pinned", "Body")
    const { value, requests } = await judged(github, judging("accept"))
    await project(value)
    await runtime.runPromise(TriageStore.pin(REPOSITORY.id, 1, true))
    const writeId = await admit(runtime, { actorId: "maya", sessionId: null, via: "person", payload: { op: "triage/run", number: 1 } })
    const ran = await runFlow(Triage.TriageRun, { repo: REPO, number: 1, trigger: "again", key: writeId }, Triage.registration(value), {
      maxConnections: 3,
    })
    expect(ran.exit).toEqual(Exit.succeed({ outcome: "skipped", decisionId: null }))
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done" })
    expect(await triageRow(1)).toEqual({ triage: "proposed", pinned: false })
    expect(requests).toEqual([])
  })

  test("Enable and Pause: a Maintainer's, settled into the settings the shape serves", async () => {
    const github = repository()
    const person = await maya(github, "maintainer")
    const h = await githubHarness(runtime, { actor: person.actor, run: true, github })
    const enableWrite = { writeId: crypto.randomUUID(), via: "person", op: "triage/enable", dailyTokens: 5_000 }
    expect((await h.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post(enableWrite))).status).toBe(202)
    await h.settled()
    expect(await writeRow(runtime, enableWrite.writeId)).toMatchObject({ status: "done", itemNumber: null })
    expect(await settings()).toEqual({
      paused: false,
      pausedReason: null,
      dailyTokens: 5_000,
      enabledBy: person.personId,
      enabledLogin: "maya",
    })
    const shape = await h.fetch(`${TRIAGE_SETTINGS_SHAPE_ROUTE}?offset=-1`)
    expect(shape.status).toBe(200)
    const rows = (await shape.json()) as Array<{ value?: Record<string, unknown> }>
    expect(rows.flatMap((row) => (row.value === undefined ? [] : [row.value]))).toEqual([
      { repo_id: REPOSITORY.id, paused: "false", paused_reason: null, daily_tokens: "5000", enabled_at: expect.any(String) },
    ])
    const pauseWrite = { writeId: crypto.randomUUID(), via: "person", op: "triage/pause" }
    expect((await h.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post(pauseWrite))).status).toBe(202)
    await h.settled()
    expect(await settings()).toMatchObject({ paused: true, pausedReason: "person" })
    // Enabling again unpauses it, under whoever enabled it last, at the default budget.
    const again = { writeId: crypto.randomUUID(), via: "person", op: "triage/enable" }
    await h.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post(again))
    await h.settled()
    expect(await settings()).toMatchObject({ paused: false, pausedReason: null, dailyTokens: 200_000 })
  })

  test.each([
    ["a Guest overriding", "guest", { op: "issue/triage", number: 1, decision: "accept" }],
    ["a Guest running triage again", "guest", { op: "triage/run", number: 1 }],
    ["a Member enabling", "member", { op: "triage/enable" }],
    ["a Member pausing", "member", { op: "triage/pause" }],
  ] as const)("%s: 403, nothing recorded or started", async (_, role, write) => {
    const github = repository()
    const person = await maya(github, role)
    const h = await githubHarness(runtime, { actor: person.actor, github })
    const answer = await h.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post({ writeId: crypto.randomUUID(), via: "person", ...write }))
    expect(answer.status).toBe(403)
    expect(await answer.json()).toEqual({ code: "forbidden" })
    expect(h.starts).toEqual([])
    expect(await sql(runtime, `SELECT * FROM github_writes`)).toEqual([])
  })

  test("the agent never triages, enables or pauses: 403 even for an Admin", async () => {
    const github = repository()
    const person = await maya(github, "admin")
    const h = await githubHarness(runtime, { actor: { ...person.actor, act: { kind: "agent", id: "triage-test-agent" } }, github })
    for (const write of [
      { op: "issue/commitment", number: 1, commitment: "now" },
      { op: "issue/triage", number: 1, decision: "reject" },
      { op: "triage/run", number: 1 },
      { op: "triage/enable" },
      { op: "triage/pause" },
    ]) {
      const answer = await h.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post({ writeId: crypto.randomUUID(), via: "agent", ...write }))
      expect(answer.status).toBe(403)
    }
    expect(h.starts).toEqual([])
  })

  test("bounds: a reason too long or blank, a budget out of range; an override needs a session; enabling a login", async () => {
    const github = repository()
    const person = await maya(github, "admin")
    const h = await githubHarness(runtime, { actor: person.actor, github })
    const send = (write: Record<string, unknown>) =>
      h.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post({ writeId: crypto.randomUUID(), via: "person", ...write }))
    expect((await send({ op: "issue/triage", number: 1, decision: "reject", reason: "x".repeat(301) })).status).toBe(400)
    expect((await send({ op: "issue/triage", number: 1, decision: "reject", reason: "  " })).status).toBe(400)
    expect((await send({ op: "issue/triage", number: 1, decision: "maybe" })).status).toBe(400)
    expect((await send({ op: "triage/enable", dailyTokens: 0 })).status).toBe(400)
    expect((await send({ op: "triage/enable", dailyTokens: 10_000_001 })).status).toBe(400)
    const noSession = await githubHarness(runtime, { actor: { ...person.actor, session: undefined } as Actor.Actor, github })
    const override = await noSession.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post({
      writeId: crypto.randomUUID(),
      via: "person",
      op: "issue/triage",
      number: 1,
      decision: "accept",
    }))
    expect(override.status).toBe(401)
    // Run triage again and Pause act on GitHub with no person's token, so a developer with no session may.
    const pause = await noSession.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post({
      writeId: crypto.randomUUID(),
      via: "person",
      op: "triage/pause",
    }))
    expect(pause.status).toBe(202)
    const noLogin = await githubHarness(runtime, { actor: { ...person.actor, login: undefined } as Actor.Actor, github })
    const enabling = await noLogin.fetch(writesRoute(REPOSITORY.owner, REPOSITORY.name), post({
      writeId: crypto.randomUUID(),
      via: "person",
      op: "triage/enable",
    }))
    expect(enabling.status).toBe(401)
  })

  test("github/Write never runs Run triage again: admitted for triage/Run only, it settles refused", async () => {
    const github = repository()
    const writeId = await admit(runtime, { actorId: "maya", sessionId: null, via: "person", payload: { op: "triage/run", number: 1 } })
    const { services: value } = await services(runtime, github)
    const ran = await runFlow(Write.Write, { writeId }, Write.registration(value), { maxConnections: 2 })
    expect(ran.exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "invalid" })
  })

  test("an override on an issue the projection hasn't read yet counts from proposed, and pins once GitHub's row lands", async () => {
    const github = repository()
    github.open("Not synced", "Body")
    const person = await maya(github)
    const writeId = await admit(runtime, {
      actorId: person.personId,
      sessionId: person.sessionId,
      via: "person",
      payload: { op: "issue/triage", number: 1, decision: "accept", reason: null },
    })
    const { services: value } = await services(runtime, github)
    const ran = await runFlow(Write.Write, { writeId }, Write.registration(value), { maxConnections: 2 })
    expect(ran.exit).toEqual(Exit.succeed({ status: "done", itemNumber: 1 }))
    expect(await triageRow(1)).toEqual({ triage: "accepted", pinned: true })
    expect((await items(runtime))[0]).toMatchObject({ number: 1 })
    expect((await decisions())[0]).toMatchObject({ via: "person", triageBefore: "proposed", commented: false })
  })
})

test("a transient rejection-comment outage retries durably and writes one comment", async () => {
  const github = repository()
  await enable()
  github.open("Spam", "Body")
  github.faults.push({ match: (method, path) => method === "POST" && /\/comments$/.test(path), status: 502 })
  const { value } = await judged(github, judging("reject", "duplicate"))
  expect((await triage(value, 1)).exit).toEqual(Exit.succeed({ outcome: "commented", decisionId: expect.any(String) }))
  expect(githubComments(github, 1)).toHaveLength(1)
  expect((await decisions())[0]).toMatchObject({ commented: true, commentFailed: false })
}, 60_000)

test("a queued commitment whose author no longer resolves is refused without changing labels", async () => {
  const github = repository()
  github.open("Accepted", "Body")
  github.relabel(1, [ACCEPTED_LABEL])
  const person = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
  // Fault the persisted author reference; the real session still supplies its token.
  const writeId = await admit(runtime, { actorId: "missing-author", sessionId: person.sessionId, via: "person",
    payload: { op: "issue/commitment", number: 1, commitment: "now" },
  })
  const { services: value } = await services(runtime, github)
  const result = await runFlow(Write.Write, { writeId }, Write.registration(value))
  expect(result.exit).toEqual(Exit.succeed({ status: "refused", itemNumber: null }))
  expect(await writeRow(runtime, writeId)).toMatchObject({ status: "refused", failure: "not_allowed" })
  expect(github.issues.get(1)!.labels).toEqual([ACCEPTED_LABEL])
})
