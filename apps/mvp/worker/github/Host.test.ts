import { TestSchemas } from "@smthrs/database"
import * as GitHubCreation from "../branch/GitHubCreation.ts"
// What a host builds to run the git loop (worker/github/{Config,Host}.ts, worker/ExecutionHost.ts `withGitHub`): the
// App's settings from Config, the App itself, and the Durable Object's handlers running `github/Write` to the end over
// the compose Postgres (`pnpm db:up`) with an in-memory object storage, as worker/ExecutionHost.test.ts runs the others.
import * as Pg from "@effect/sql-pg"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { ConfigProvider, Context, Effect, Layer, Logger, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { writeExecutionId } from "../../src/features/issues/contract.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import * as Expire from "../flows/Expire.ts"
import { testFile } from "../test/harness.ts"
import * as Apply from "./Apply.ts"
import * as GitHubConfig from "./Config.ts"
import * as Host from "./Host.ts"
import * as Merge from "./Merge.ts"
import * as Reconcile from "./Reconcile.ts"
import * as Relations from "./Relations.ts"
import { admit, database, judgeSeat, judging, keys, reset, signedIn, writeRow } from "./test/fixtures.ts"
import { APP_ID, appKey, SCRIPTED_API, scriptedGitHub } from "./test/scriptedGitHub.ts"
import * as Triage from "./Triage.ts"
import * as MachineWrite from "./MachineWrite.ts"
import * as Write from "./Write.ts"

const runtime = testFile("github_host")

beforeEach(() => reset(runtime))

const configured = (values: Record<string, string>) =>
  Effect.runPromise(GitHubConfig.configured.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values)))))

describe("Config", () => {
  test("without the App's ID or key the git loop is off; with them, its settings and the repository", async () => {
    expect(await configured({})).toEqual(Option.none())
    expect(await configured({ GITHUB_APP_ID: APP_ID })).toEqual(Option.none())
    expect(await configured({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: "  " })).toEqual(Option.none())
    const on = await configured({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: "key", GITHUB_WEBHOOK_SECRET: "" })
    expect(Option.getOrThrow(on)).toMatchObject({
      appId: APP_ID,
      webhookSecret: Option.none(),
      repository: { owner: "smithersai", name: "smithers", id: "github/smithersai/smithers" },
      apiBaseUrl: "https://api.github.com",
    })
    const custom = await configured({
      GITHUB_APP_ID: APP_ID,
      GITHUB_APP_PRIVATE_KEY: "key",
      GITHUB_WEBHOOK_SECRET: "secret",
      GITHUB_REPOSITORY: "Acme/Widgets",
      GITHUB_API_URL: SCRIPTED_API,
    })
    expect(Option.getOrThrow(custom)).toMatchObject({
      repository: { owner: "Acme", name: "Widgets", id: "github/acme/widgets" },
      apiBaseUrl: SCRIPTED_API,
    })
    expect(Option.isSome(Option.getOrThrow(custom).webhookSecret)).toBe(true)
  })

  test("a GITHUB_API_URL that isn't an http(s) URL fails the deployment's config", async () => {
    for (const url of ["not a url", "ftp://api.github.test"]) {
      const exit = await Effect.runPromiseExit(
        GitHubConfig.configured.pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: "k", GITHUB_API_URL: url })),
          ),
        ),
      )
      expect(exit._tag).toBe("Failure")
    }
  })
})

describe("Host", () => {
  const ready = async (values: Record<string, string>) => {
    const github = scriptedGitHub()
    const logs: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
    const made = await Effect.runPromise(
      Host.ready(await database(runtime)).pipe(
        Effect.provide(github.layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))),
        Effect.provide(Logger.layer([Logger.make((log) => void logs.push(StructuredLogger.formatStructured.log(log)))])),
      ),
    )
    return { made, logs, github }
  }

  test("the App from config: none without it; a key that doesn't import logs its code only, never the key", async () => {
    expect((await ready({})).made).toEqual(Option.none())
    const bad = await ready({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nnot-a-key-sentinel\n-----END PRIVATE KEY-----" })
    expect(bad.made).toEqual(Option.none())
    expect(bad.logs.map((log) => log.message)).toEqual(["github.config"])
    expect(JSON.stringify(bad.logs)).not.toContain("not-a-key-sentinel")
    const key = Redacted.value(await appKey())
    const good = await ready({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: key, GITHUB_API_URL: SCRIPTED_API })
    expect(Option.getOrThrow(good.made).apiBaseUrl).toBe(SCRIPTED_API)
    // Its JWT is the App's: the scripted GitHub takes it.
    const installation = await Effect.runPromise(Option.getOrThrow(good.made).app.installation("acme", "widgets"))
    expect(installation).toEqual({ id: 77 })
  })

  test("the Durable Object's handlers run github/Write to the end through withGitHub", async () => {
    const github = scriptedGitHub()
    const token = github.userToken("maya")
    const person = await signedIn(runtime, { login: "maya", token })
    const writeId = await admit(runtime, {
      actorId: person.personId,
      sessionId: person.sessionId,
      via: "person",
      payload: { op: "issue/create", title: "From the object", body: "Body" },
    })
    const key = Redacted.value(await appKey())
    const app = await database(runtime)
    const made = Option.getOrThrow(
      await Effect.runPromise(
        Host.ready(app).pipe(
          Effect.provide(github.layer),
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ GITHUB_APP_ID: APP_ID, GITHUB_APP_PRIVATE_KEY: key, GITHUB_API_URL: SCRIPTED_API })),
          ),
        ),
      ),
    )
    const sessionKeys = await keys()
    const { seat } = await judgeSeat(runtime, judging("abstain"))
    const flows = ExecutionHost.withGitHub(
      ExecutionHost.remote({ database: app, expiry: Expire.DEFAULT_EXPIRY }),
      Effect.succeed(
        Host.services(
          made,
          { keys: Option.some(sessionKeys), refresh: () => Effect.void },
          () => seat,
        ),
      ),
    )
    expect(flows.flows.slice(-8)).toEqual([Apply.Apply, Reconcile.Reconcile, Relations.Relations, Write.Write, MachineWrite.MachineDispatch, Triage.TriageRun, Merge.Merge, GitHubCreation.Create])
    const values = new Map<string, unknown>()
    const storage: ExecutionHost.Storage = {
      get: <A>(storageKey: string) => Effect.sync(() => structuredClone(values.get(storageKey)) as A | undefined),
      put: (storageKey, value) => Effect.sync(() => void values.set(storageKey, structuredClone(value))),
      delete: (storageKey) => Effect.sync(() => values.delete(storageKey)),
      setAlarm: () => Effect.void,
      deleteAlarm: () => Effect.void,
    }
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function* () {
        const url = (yield* TestDatabase.serverUrl).toString()
        const admin = yield* Layer.build(Pg.PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }))
        const sql = Context.get(admin, SqlClient.SqlClient)
        const name = TestSchemas.schemaName("flows")
        yield* Effect.addFinalizer(() => Effect.orDie(sql`DROP SCHEMA IF EXISTS ${sql(name)} CASCADE`))
        const executionId = writeExecutionId(writeId)
        const host = ExecutionHost.make(storage, {
          hostId: `object-${executionId}`,
          database: ExecutionHost.database(url, name),
          flows: { ...flows, registration: flows.registration.pipe(
            Layer.provide(Layer.succeed(GitHubCreation.Settings, { app: Option.none(), allowed: Option.none(), configReads: { token: { token: Option.none(), app: Option.none() }, visibilityApi: "https://api.github.com" } })),
          ) },
          router: { start: () => Effect.void, wake: () => Effect.void },
        })
        yield* host.start(yield* ExecutionHost.intent(Write.Write, { executionId, payload: { writeId } }))
        let driven = yield* host.alarm()
        for (let drives = 1; driven._tag !== "Settled" && drives < 20; drives++) driven = yield* host.alarm()
        expect(driven).toMatchObject({ _tag: "Settled" })
      })),
    )
    expect(await writeRow(runtime, writeId)).toMatchObject({ status: "done", itemNumber: 1 })
    expect(github.issues.get(1)!.login).toBe("maya")
  })
})
