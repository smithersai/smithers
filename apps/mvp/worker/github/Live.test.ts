// The git loop against the real GitHub (docs/features/issues.md#tests): the App's JWT and an installation token, then
// the real `github/Write`, `github/Apply` and `github/Reconcile` on the Node host over this file's schema, on a scratch
// repository Will owns with the App installed. It never touches `smithersai/*`: a test once posted on smithers#1.
// Each case skips, naming the variables it needs, until they are set:
// - GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY: the Smithers GitHub App, with Issues read and write (decision 0012 question 2);
// - GITHUB_LIVE_REPOSITORY: `owner/name` of the scratch repository the App is installed on;
// - GITHUB_LIVE_USER_TOKEN: a `ghu_` user token of the test account (`codeplanesmithers`), for a person's own write;
// - GITHUB_LIVE_MAINTAINER: the login of a Maintainer or Admin on the scratch repository, who enables triage there
//   (docs/features/issues.md#triage); the triage case decides with a scripted judge, so its writes are certain, and, when
//   CEREBRAS_API_KEY is set too, once more with the deployment's real model on the `judge` role.
import { GitHub } from "@smthrs/integrations"
import { HostModel } from "@smthrs/model-host"
import { ConfigProvider, Effect, Exit, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { beforeEach, describe, expect, test } from "vitest"
import { ACCEPTED_LABEL, NOT_ACCEPTED_LABEL, triageRunExecutionId } from "../../src/features/issues/contract.ts"
import * as ModelEndpoint from "../ModelEndpoint.ts"
import { PersonalModels } from "../personal/Models.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as Apply from "./Apply.ts"
import { DEFAULT_API_URL, repositoryOf } from "./Config.ts"
import * as Reconcile from "./Reconcile.ts"
import * as Store from "./Store.ts"
import { database, judgeSeat, judging, keys, reset, signedIn, sql } from "./test/fixtures.ts"
import * as Tokens from "./Tokens.ts"
import * as Triage from "./Triage.ts"
import * as TriageStore from "./TriageStore.ts"
import * as Write from "./Write.ts"

const runtime = testFile("github_live")

beforeEach(() => reset(runtime))

const env = process.env
const missing = (names: ReadonlyArray<string>) => names.filter((name) => (env[name] ?? "").trim() === "")
const scratch = env["GITHUB_LIVE_REPOSITORY"] ?? ""
// Never a repository of the Smithers organization, whatever the environment says.
const refused = /^smithersai\//i.test(scratch)

const appNeeds = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_LIVE_REPOSITORY"]
const appMissing = missing(appNeeds)
const userMissing = missing([...appNeeds, "GITHUB_LIVE_USER_TOKEN"])
const triageMissing = missing([...appNeeds, "GITHUB_LIVE_MAINTAINER"])
const modelMissing = missing([...appNeeds, "GITHUB_LIVE_MAINTAINER", "CEREBRAS_API_KEY"])
if (appMissing.length > 0) console.warn(`The live GitHub App cases are skipped: set ${appMissing.join(", ")}.`)
if (userMissing.length > 0) console.warn(`The live person's write is skipped: set ${userMissing.join(", ")}.`)
if (triageMissing.length > 0) console.warn(`The live triage is skipped: set ${triageMissing.join(", ")}.`)
if (modelMissing.length > 0) console.warn(`The live triage with the real model is skipped: set ${modelMissing.join(", ")}.`)
if (refused) console.warn("The live GitHub cases are skipped: GITHUB_LIVE_REPOSITORY may not be a smithersai repository.")

/** The flows' services over the real GitHub and this file's schema. */
const live = async () => {
  const app = await Effect.runPromise(
    GitHub.AppAuth.make({
      appId: env["GITHUB_APP_ID"]!,
      privateKey: Redacted.make(env["GITHUB_APP_PRIVATE_KEY"]!),
      apiBaseUrl: DEFAULT_API_URL,
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  )
  const http = await Effect.runPromise(Effect.service(HttpClient.HttpClient).pipe(Effect.provide(FetchHttpClient.layer)))
  return {
    database: await database(runtime),
    http,
    apiBaseUrl: DEFAULT_API_URL,
    tokens: Tokens.make({ app, keys: Option.some(await keys()), refresh: () => Effect.void }),
  } satisfies Apply.Services
}

const admit = (write: Parameters<typeof Store.insertWrite>[0]) => runtime.runPromise(Store.insertWrite(write))

describe.skipIf(appMissing.length > 0 || refused)("the real GitHub, as the App", () => {
  test("reconciles the scratch repository, opens an issue as the App, and a webhook-style re-read finds it", async () => {
    const repository = repositoryOf(scratch)
    const services = await live()
    const reconciled = await runFlow(Reconcile.Reconcile, { repo: scratch, requestedAtMs: Date.now() }, Reconcile.registration(services), { maxConnections: 3 })
    expect(reconciled.exit._tag).toBe("Success")
    expect(await sql(runtime, `SELECT private FROM github_repositories`)).toEqual([{ private: expect.any(Boolean) }])
    const writeId = crypto.randomUUID()
    await admit({
      id: writeId,
      repoId: repository.id,
      actorId: "live-test",
      sessionId: null,
      via: "agent",
      payload: { op: "issue/create", title: `Smithers live test ${new Date().toISOString()}`, body: "Opened by the live test." },
      payloadHash: "0".repeat(64),
    })
    const written = await runFlow(Write.Write, { writeId }, Write.registration(services), { maxConnections: 3 })
    expect(written.exit).toEqual(Exit.succeed({ status: "done", itemNumber: expect.any(Number) }))
    const number = (written.exit as Exit.Success<Write.Written, never>).value.itemNumber!
    console.info(`live: opened ${scratch}#${number} as the App (write ${writeId})`)
    const applied = await runFlow(
      Apply.Apply,
      { deliveryId: crypto.randomUUID(), repo: scratch, number, event: "issues" },
      Apply.registration(services),
      { maxConnections: 3 },
    )
    expect(applied.exit).toEqual(Exit.succeed({ outcome: "applied", changed: expect.any(Number) }))
    expect(await sql(runtime, `SELECT author_login AS author, write_id::text AS "writeId" FROM items WHERE number = ${number}`))
      .toEqual([{ author: expect.stringMatching(/\[bot\]$/), writeId }])
  }, 120_000)
})

describe.skipIf(userMissing.length > 0 || refused)("the real GitHub, as a person", () => {
  test("a person's comment shows on GitHub as that person", async () => {
    const repository = repositoryOf(scratch)
    const services = await live()
    const token = Redacted.make(env["GITHUB_LIVE_USER_TOKEN"]!)
    const person = await signedIn(runtime, { login: "codeplanesmithers", token })
    const opened = crypto.randomUUID()
    await admit({
      id: opened,
      repoId: repository.id,
      actorId: person.personId,
      sessionId: person.sessionId,
      via: "person",
      payload: { op: "issue/create", title: `Smithers live test (person) ${new Date().toISOString()}`, body: "As a person." },
      payloadHash: "0".repeat(64),
    })
    const written = await runFlow(Write.Write, { writeId: opened }, Write.registration(services), { maxConnections: 3 })
    expect(written.exit).toEqual(Exit.succeed({ status: "done", itemNumber: expect.any(Number) }))
    const [row] = (await sql(runtime, `SELECT author_login AS author FROM items WHERE write_id = '${opened}'`)) as unknown as [
      { author: string },
    ]
    expect(row.author).not.toMatch(/\[bot\]$/)
  }, 120_000)
})

describe.skipIf(triageMissing.length > 0 || refused)("the real GitHub, triage", () => {
  const maintainer = env["GITHUB_LIVE_MAINTAINER"] ?? ""

  /** Opens a fresh issue on the scratch repository as the App, and enables triage under the Maintainer. */
  const arrange = async (services: Apply.Services, title: string, body: string) => {
    const repository = repositoryOf(scratch)
    await runtime.runPromise(TriageStore.enable(repository.id, { actorId: "live-maintainer", login: maintainer, dailyTokens: 50_000 }))
    const writeId = crypto.randomUUID()
    await admit({
      id: writeId,
      repoId: repository.id,
      actorId: "live-test",
      sessionId: null,
      via: "agent",
      payload: { op: "issue/create", title: `${title} ${new Date().toISOString()}`, body },
      payloadHash: "0".repeat(64),
    })
    const written = await runFlow(Write.Write, { writeId }, Write.registration(services), { maxConnections: 3 })
    return (written.exit as Exit.Success<Write.Written, never>).value.itemNumber!
  }

  /** The issue's labels on GitHub, and its comments' authors and first lines, as the App reads them. */
  const onGitHub = (services: Apply.Services, number: number) => {
    const repository = repositoryOf(scratch)
    return Effect.runPromise(
      Effect.gen(function* () {
        const token = yield* services.tokens.forInstallation(repository, "read")
        return yield* Effect.gen(function* () {
          const issue = yield* GitHub.Issues.getIssue(repository.owner, repository.name, number)
          const comments = yield* GitHub.Issues.listComments(repository.owner, repository.name, number)
          return {
            labels: issue.labels.map((label) => label.name),
            state: issue.state,
            comments: comments.items.map((comment) => [comment.user?.login ?? "", (comment.body ?? "").split("\n")[0]]),
          }
        }).pipe(
          Effect.provideService(
            GitHub.GitHubClient.GitHubClient,
            yield* GitHub.GitHubClient.make({ token: Redacted.value(token), apiBaseUrl: DEFAULT_API_URL }, {}),
          ),
        )
      }).pipe(Effect.provide(services.database), Effect.provideService(HttpClient.HttpClient, services.http)),
    )
  }

  test("a new spam issue: the App labels it not accepted and comments once, naming the enabler; it stays open", async () => {
    const base = await live()
    const services: Triage.Services = { ...base, judge: (await judgeSeat(runtime, judging("reject", "spam"))).seat }
    const number = await arrange(base, "Smithers live triage (spam)", "Buy cheap watches, ping @everyone http://spam.example")
    const key = crypto.randomUUID()
    const ran = await runFlow(Triage.TriageRun, { repo: scratch, number, trigger: "opened", key }, Triage.registration(services), {
      executionId: triageRunExecutionId(key),
      maxConnections: 3,
    })
    expect(ran.exit).toEqual(Exit.succeed({ outcome: "commented", decisionId: expect.any(String) }))
    console.info(`live: triaged ${scratch}#${number} not accepted`)
    const seen = await onGitHub(base, number)
    expect(seen.labels).toContain(NOT_ACCEPTED_LABEL)
    expect(seen.labels).not.toContain(ACCEPTED_LABEL)
    expect(seen.state).toBe("open")
    expect(seen.comments).toEqual([[expect.stringMatching(/\[bot\]$/), "Not accepted: Spam."]])
    expect(await sql(runtime, `SELECT triage FROM items WHERE number = ${number}`)).toEqual([{ triage: "not_accepted" }])
  }, 180_000)

  test.skipIf(modelMissing.length > 0)("the real judge decides a clear bug report, and GitHub carries what it decided", async () => {
    const base = await live()
    const local = await Effect.runPromise(
      ModelEndpoint.local(base.database, { hosted: true }).pipe(
        Effect.provide(PersonalModels.none),
        Effect.provide(
          HostModel.layerConfig("CHAT_MODEL", {
            protocol: "openai-chat",
            baseUrl: "https://api.cerebras.ai",
            modelId: "qwen-3.8-27b",
            credential: "CEREBRAS_API_KEY",
          }),
        ),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
      ),
    )
    const services: Triage.Services = { ...base, judge: local("judge") }
    const number = await arrange(
      base,
      "Smithers live triage (bug)",
      "Steps: 1. Open the issues page. 2. Press New issue with an empty title. Expected: a message. Actual: the page crashes.",
    )
    const key = crypto.randomUUID()
    const ran = await runFlow(Triage.TriageRun, { repo: scratch, number, trigger: "opened", key }, Triage.registration(services), {
      executionId: triageRunExecutionId(key),
      maxConnections: 3,
    })
    expect(Exit.isSuccess(ran.exit)).toBe(true)
    const [decision] = (await sql(runtime, `SELECT decision, abstained, tokens FROM triage_decisions`)) as unknown as [
      { decision: string; abstained: string | null; tokens: number },
    ]
    console.info(
      `live: the real judge decided ${scratch}#${number} ${decision.decision}${
        decision.abstained === null ? "" : ` (${decision.abstained})`
      } with ${decision.tokens} tokens`,
    )
    expect(decision.tokens).toBeGreaterThan(0)
    const seen = await onGitHub(base, number)
    expect(seen.labels.filter((label) => label.startsWith("smithers:"))).toEqual(
      decision.decision === "accept" ? [ACCEPTED_LABEL] : decision.decision === "reject" ? [NOT_ACCEPTED_LABEL] : [],
    )
  }, 180_000)
})
