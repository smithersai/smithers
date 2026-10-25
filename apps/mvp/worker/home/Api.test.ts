import { Logger as StructuredLogger } from "@smthrs/observability"
import { Home } from "@smthrs/views"
import { Effect, Layer, Logger, Metric, Option, Redacted, Schema, Tracer } from "effect"
import { HttpEffect } from "effect/http"
import { beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { HomeAnswer } from "../../src/features/home/schema.ts"
import * as Actor from "../Actor.ts"
import { repositoryOf } from "../github/Config.ts"
import * as RepoRoles from "../github/RepoRoles.ts"
import { reset, sql } from "../github/test/fixtures.ts"
import { app } from "../github/test/harness.ts"
import { accountIdOf, appKey, type ScriptedGitHub, scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import { signedIn, testFile } from "../test/harness.ts"
import { handles, make, parseHomePath, parseRolePath, requests, roleRequests } from "./Api.ts"
import * as Curated from "./Curated.ts"

// `GET /api/repos/<owner>/<name>/home`: who the asker is and the curated home, with only the sections their audience
// may see. The handler runs as ChatApi runs it, with who is asking from a `Sessions` layer (signed out, each role, or
// a session store that can't answer) and their role on the routed repository from the real `RepoRoles` (decision
// 0079) over this file's schema of the compose Postgres and the scripted GitHub: the session's role on the
// deployment's own repository, GitHub's on any other. Unhappy paths give it a faulty GitHub, an unreachable Postgres
// or a session store that can't answer (test.faults-by-injection).

type StructuredLog = ReturnType<typeof StructuredLogger.formatStructured.log>

const runtime = testFile("home_roles")

/** Maya as sign-in recorded her: her person id, login and GitHub account (the one the scripted GitHub gives her). */
const MAYA = "4b6d2f1a-8c3e-4a5b-9d7f-0e1a2b3c4d5e"
beforeEach(async () => {
  await reset(runtime)
  await sql(runtime, `INSERT INTO people (id, github_id, github_login) VALUES ('${MAYA}', ${accountIdOf("maya")}, 'maya')`)
})

/** Maya, signed in with `role` on the deployment's own repository. */
const person = (role: Actor.Role | null): Actor.Actor => ({ subject: { kind: "person", id: MAYA }, role, login: "maya" })

const unavailable = Layer.succeed(
  Actor.Sessions,
  Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) }),
)

const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))

let key: Redacted.Redacted<string> | undefined

interface RouteOptions {
  readonly sessions?: Layer.Layer<Actor.Sessions>
  readonly files?: ReadonlyArray<Curated.CuratedFile>
  /** The deployment's own repository (`GITHUB_REPOSITORY`), `owner/name`: Effect's unless set. */
  readonly own?: string
  /** The scripted GitHub the App reads roles on other repositories from; none, no App on this deployment. */
  readonly github?: ScriptedGitHub
  /** Postgres in place of the file's schema, such as one that can't be reached. */
  readonly database?: typeof unreachable
  /** Local development without the App: the session's role holds everywhere (worker/DevChatApi.ts). */
  readonly local?: boolean
  /** Which repositories the deployment syncs (worker/github/Api.ts `maySync`); unset, the answer doesn't say. */
  readonly maySync?: (target: ReturnType<typeof repositoryOf>) => Effect.Effect<boolean>
}

/**
 * The route over `sessions` and `files`, with roles from the real `RepoRoles`, recording what it logs, spans and
 * counts.
 */
const route = async (options: RouteOptions = {}) => {
  const logs: Array<StructuredLog> = []
  const spans: Array<Tracer.NativeSpan> = []
  const registry: Metric.MetricRegistry = new Map()
  const tracer = Tracer.make({
    span(spanOptions) {
      const span = new Tracer.NativeSpan(spanOptions)
      spans.push(span)
      return span
    },
  })
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  key ??= await appKey()
  const roles = await runtime.runPromise(RepoRoles.make(options.database ?? scratch.database, {
    repository: repositoryOf(options.own ?? "Effect-TS/effect"),
    app: options.github === undefined ? Option.none() : Option.some(app({ privateKey: key })),
    ...(options.github === undefined ? {} : { http: options.github.http }),
    ...(options.local === undefined ? {} : { local: options.local }),
  }))
  const handler = HttpEffect.toWebHandler(
    make({
      roles,
      ...(options.files === undefined ? {} : { files: options.files }),
      ...(options.maySync === undefined ? {} : { maySync: options.maySync }),
    }).fetch.pipe(
      Effect.provide(options.sessions ?? Actor.signedOut),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((log) => void logs.push(StructuredLogger.formatStructured.log(log)))])),
      Effect.provideService(Metric.MetricRegistry, registry),
    ),
  )
  return {
    get: (path: string, init?: RequestInit) => handler(new Request(`http://chat.test${path}`, init)),
    logs,
    spans,
    line: () => logs.find((log) => log.message === "home.curated"),
    count: (attributes: Record<string, string>) =>
      Effect.runSync(
        Metric.value(Metric.withAttributes(requests, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      ).count,
    roleCount: (attributes: Record<string, string>) =>
      Effect.runSync(
        Metric.value(Metric.withAttributes(roleRequests, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      ).count,
  }
}

const EFFECT = "/api/repos/Effect-TS/effect/home"

/** The scripted GitHub's repository, where the App is installed: another repository than the deployment's own. */
const WIDGETS = "/api/repos/acme/widgets/home"

/** A curated home for acme/widgets with a section for each audience, as Effect's has. */
const WIDGETS_HOME: ReadonlyArray<Curated.CuratedFile> = [{
  repository: "acme/widgets",
  defaultBranch: "main",
  home: {
    sections: [
      { title: "Today", audience: "maintainer", blocks: [{ type: "runs" }] },
      { title: "Your work", audience: "contributor", blocks: [{ type: "stack" }] },
      { blocks: [{ type: "text", text: "Hi" }] },
    ],
  },
}]

const answerOf = async (response: Response) => Schema.decodeUnknownSync(HomeAnswer)(await response.json())

/** Each section the answer holds, as `audience:title`. */
const shape = (answer: HomeAnswer) =>
  answer.curated === null ? null : answer.curated.sections.map((section) => `${section.audience}:${section.title ?? ""}`)

describe("GET /api/repos/<owner>/<name>/home", () => {
  test("signed out: everyone's audience, and only everyone's sections of the curated home", async () => {
    const r = await route()
    const response = await r.get(EFFECT)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("vary")).toBe("cookie")
    const text = await response.clone().text()
    const answer = await answerOf(response)
    expect(answer.audience).toBe("everyone")
    expect(answer.curated?.defaultBranch).toBe("main")
    expect(shape(answer)).toEqual(["everyone:"])
    // Nothing of the Maintainers' or Members' sections reaches the browser: not a title, not a block.
    for (const hidden of ["Today", "Your work", "\"issues\"", "\"runs\"", "\"stack\""]) expect(text).not.toContain(hidden)
    expect(r.line()).toMatchObject({ annotations: { source: "signed_out" } })
  })

  test("each role on the deployment's own repository sees its own sections and the wider ones, in the file's order", async () => {
    const seen = async (role: Actor.Role | null) =>
      shape(await answerOf(await (await route({ sessions: signedIn(person(role)) })).get(EFFECT)))
    expect(await seen(null)).toEqual(["everyone:"])
    expect(await seen("guest")).toEqual(["contributor:Your work", "everyone:"])
    expect(await seen("member")).toEqual(["contributor:Your work", "everyone:"])
    expect(await seen("maintainer")).toEqual(["maintainer:Today", "contributor:Your work", "everyone:"])
    expect(await seen("admin")).toEqual(["maintainer:Today", "contributor:Your work", "everyone:"])
    const answer = await answerOf(await (await route({ sessions: signedIn(person("maintainer")) })).get(EFFECT))
    expect(answer.audience).toBe("maintainer")
  })

  test("a curated home open to anyone shows its contributors' sections to a visitor, never its maintainers'", async () => {
    const files: ReadonlyArray<Curated.CuratedFile> = [{
      repository: "maya/tinyhttp",
      defaultBranch: "main",
      home: {
        contributors: "anyone",
        sections: [
          { title: "Today", audience: "maintainer", blocks: [{ type: "runs" }] },
          { title: "Contribute", audience: "contributor", blocks: [{ type: "stack" }] },
          { blocks: [{ type: "text", text: "Hi" }] },
        ],
      },
    }]
    const answer = await answerOf(await (await route({ files })).get("/api/repos/maya/tinyhttp/home"))
    expect([answer.audience, shape(answer)]).toEqual(["contributor", ["contributor:Contribute", "everyone:"]])
    const maintainer = await answerOf(
      await (await route({ sessions: signedIn(person("admin")), files, own: "maya/tinyhttp" })).get("/api/repos/maya/tinyhttp/home"),
    )
    expect(maintainer.audience).toBe("maintainer")
    // An Admin of another repository, with no role here, is a visitor here, widened like one.
    const elsewhere = await answerOf(await (await route({ sessions: signedIn(person("admin")), files })).get("/api/repos/maya/tinyhttp/home"))
    expect(elsewhere.audience).toBe("contributor")
  })

  test("a curated home that names docs answers them, for the Docs tab; one that names none answers none", async () => {
    const docs = "https://docs.example/llms.txt"
    const files: ReadonlyArray<Curated.CuratedFile> = [
      { repository: "acme/widgets", defaultBranch: "main", home: { docs, blocks: [{ type: "text", text: "Hi" }] } },
    ]
    expect((await answerOf(await (await route({ files })).get(WIDGETS))).curated?.docs).toBe(docs)
    expect((await answerOf(await (await route()).get(EFFECT))).curated).not.toHaveProperty("docs")
  })

  test("names compare without case, as GitHub's do", async () => {
    const answer = await answerOf(await (await route()).get("/api/repos/effect-ts/EFFECT/home"))
    expect(answer.curated?.defaultBranch).toBe("main")
    // The deployment's own repository compares without case too.
    const maintainer = await answerOf(await (await route({ sessions: signedIn(person("maintainer")) })).get("/api/repos/EFFECT-TS/Effect/home"))
    expect(maintainer.audience).toBe("maintainer")
  })

  test("a repository Smithers has no home for: the audience, and no curated home", async () => {
    const r = await route({ sessions: signedIn(person("member")), own: "octocat/spoon-knife" })
    expect(await answerOf(await r.get("/api/repos/octocat/Spoon-Knife/home"))).toEqual({ audience: "contributor", curated: null })
    expect(r.count({ outcome: "absent", audience: "contributor" })).toBe(1)
    expect(r.line()).toMatchObject({ annotations: { source: "role" } })
  })

  test("a curated file that isn't a home answers none, and says so in its records", async () => {
    const files: ReadonlyArray<Curated.CuratedFile> = [
      { repository: "maya/tinyhttp", defaultBranch: "main", home: { blocks: [{ type: "text", text: "<b>no</b>" }] } },
    ]
    const r = await route({ files })
    expect(await answerOf(await r.get("/api/repos/maya/tinyhttp/home"))).toEqual({ audience: "everyone", curated: null })
    expect(r.line()).toMatchObject({
      level: "WARN",
      annotations: { outcome: "invalid", audience: "everyone", status: 200 },
    })
  })

  test("a session store that can't answer is 503, to be asked again", async () => {
    const r = await route({ sessions: unavailable })
    const response = await r.get(EFFECT)
    expect(response.status).toBe(503)
    expect(response.headers.get("retry-after")).toBe("5")
    expect(await response.json()).toEqual({ code: "unavailable" })
    expect(r.count({ outcome: "unavailable", audience: "none" })).toBe(1)
  })

  test("only GET", async () => {
    const r = await route()
    const response = await r.get(EFFECT, { method: "POST" })
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET")
    expect(r.count({ outcome: "method", audience: "none" })).toBe(1)
  })

  test("records an outcome, the audience and counts: one span, one line, one count, never a section's words", async () => {
    const r = await route({ sessions: signedIn(person("member")) })
    await r.get(EFFECT)
    const lines = r.logs.filter((log) => log.message === "home.curated")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      level: "INFO",
      annotations: { outcome: "curated", audience: "contributor", sections: 2, hidden: 1, source: "role", status: 200 },
    })
    // The route's span, and the role's read inside it.
    expect(r.spans.map((span) => span.name)).toEqual(["home.curated", "github.repo_role"])
    expect(Object.fromEntries(r.spans[0]!.attributes)).toMatchObject({
      "smithers.home.outcome": "curated",
      "smithers.home.audience": "contributor",
    })
    expect(r.count({ outcome: "curated", audience: "contributor" })).toBe(1)
    const records = JSON.stringify({ logs: r.logs, spans: r.spans.map((span) => [...span.attributes]) })
    for (const words of ["Your work", "Effect", "npm install", "maya"]) expect(records).not.toContain(words)
  })
})

describe("roles per repository (decision 0079, ruling SCOPE-14)", () => {
  test.each([
    ["admin", "maintainer", ["maintainer:Today", "contributor:Your work", "everyone:"]],
    ["maintain", "maintainer", ["maintainer:Today", "contributor:Your work", "everyone:"]],
    ["write", "contributor", ["contributor:Your work", "everyone:"]],
    ["triage", "contributor", ["contributor:Your work", "everyone:"]],
    // GitHub answers read for anyone signed in on a public repository: they may contribute, so they see Contribute.
    ["read", "contributor", ["contributor:Your work", "everyone:"]],
  ] as const)("another repository the App is installed on: GitHub's %s there is the %s view", async (permission, audience, sections) => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", permission)
    // Maya is nobody on the deployment's own repository: only her permission on acme/widgets counts here.
    const r = await route({ sessions: signedIn(person(null)), files: WIDGETS_HOME, github })
    const answer = await answerOf(await r.get(WIDGETS))
    expect([answer.audience, shape(answer)]).toEqual([audience, sections])
    expect(github.seen("GET", /\/collaborators\/maya\/permission$/)).toHaveLength(1)
    expect(r.line()).toMatchObject({ annotations: { outcome: "curated", audience, source: "role" } })
  })

  test("a role on one repository never counts on another: the deployment's Admin who is nobody on acme/widgets is a visitor there", async () => {
    const github = scriptedGitHub("acme", "widgets")
    const r = await route({ sessions: signedIn(person("admin")), files: WIDGETS_HOME, github })
    const response = await r.get(WIDGETS)
    const text = await response.clone().text()
    expect([(await answerOf(response)).audience]).toEqual(["everyone"])
    for (const hidden of ["Today", "Your work"]) expect(text).not.toContain(hidden)
    // Still the Admin on the deployment's own repository, asking GitHub nothing there.
    const own = await answerOf(await r.get(EFFECT))
    expect(own.audience).toBe("maintainer")
    expect(github.seen("GET", /\/permission$/)).toHaveLength(1)
  })

  test("nor the other way: a Maintainer of acme/widgets who is a Guest on the deployment's own repository is a contributor there", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "maintain")
    const r = await route({ sessions: signedIn(person("guest")), github })
    expect((await answerOf(await r.get(WIDGETS))).audience).toBe("maintainer")
    expect((await answerOf(await r.get(EFFECT))).audience).toBe("contributor")
    // The role GitHub gave on acme/widgets is kept for that repository alone.
    expect(await sql(runtime, `SELECT repo_id, role FROM github_repo_roles`)).toEqual([
      { repo_id: "github/acme/widgets", role: "maintainer" },
    ])
  })

  test("a role read a moment ago decides for 5 minutes, then GitHub is asked again", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "admin")
    const r = await route({ sessions: signedIn(person(null)), files: WIDGETS_HOME, github })
    expect((await answerOf(await r.get(WIDGETS))).audience).toBe("maintainer")
    github.roles.set("maya", "read")
    expect((await answerOf(await r.get(WIDGETS))).audience).toBe("maintainer")
    expect(github.seen("GET", /\/permission$/)).toHaveLength(1)
    await sql(runtime, `UPDATE github_repo_roles SET checked_at = now() - interval '${RepoRoles.FRESH_SECONDS + 1} seconds'`)
    expect((await answerOf(await r.get(WIDGETS))).audience).toBe("contributor")
    expect(github.seen("GET", /\/permission$/)).toHaveLength(2)
  })

  test("signed out on another repository: everyone, and GitHub is asked nothing", async () => {
    const github = scriptedGitHub("acme", "widgets")
    const r = await route({ files: WIDGETS_HOME, github })
    expect((await answerOf(await r.get(WIDGETS))).audience).toBe("everyone")
    expect(github.calls).toEqual([])
  })

  test("where the deployment can't act, nobody has a role: the App not installed, or none configured", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "admin")
    github.installed = false
    const notInstalled = await route({ sessions: signedIn(person("admin")), files: WIDGETS_HOME, github })
    const response = await notInstalled.get(WIDGETS)
    expect(response.status).toBe(200)
    expect([(await answerOf(response)).audience]).toEqual(["everyone"])
    expect(notInstalled.line()).toMatchObject({
      level: "INFO",
      annotations: { outcome: "curated", audience: "everyone", source: "no_role_here", refused: "app_not_installed" },
    })
    // A deployment without the App reads no role on any repository but its own.
    const noApp = await route({ sessions: signedIn(person("admin")), files: WIDGETS_HOME })
    expect((await answerOf(await noApp.get(WIDGETS))).audience).toBe("everyone")
    expect(noApp.line()).toMatchObject({ annotations: { source: "no_role_here", refused: "not_configured" } })
  })

  test("local development without the App: the developer's role holds on every repository, as RepoRoles says", async () => {
    const r = await route({ sessions: signedIn(person("maintainer")), files: WIDGETS_HOME, local: true })
    expect((await answerOf(await r.get(WIDGETS))).audience).toBe("maintainer")
  })

  test.each([
    [{ status: 429, headers: { "retry-after": "30" } }, 429, "rate_limited", "30"],
    [{ status: 502 }, 503, "github_unavailable", "5"],
    [{ lost: true }, 503, "github_unavailable", "5"],
  ] as const)("GitHub failing (%o) is %i %s, never a guessed role", async (fault, status, code, wait) => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "admin")
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), ...fault })
    const r = await route({ sessions: signedIn(person("admin")), files: WIDGETS_HOME, github })
    const response = await r.get(WIDGETS)
    expect([response.status, response.headers.get("retry-after"), response.headers.get("cache-control")]).toEqual([
      status,
      wait,
      "no-store",
    ])
    expect(await response.json()).toEqual({ code })
    expect(r.line()).toMatchObject({ level: "WARN", annotations: { outcome: "role_unavailable", refused: code, status } })
    expect(r.count({ outcome: "role_unavailable", audience: "none" })).toBe(1)
    // Asked again, GitHub answers.
    expect((await answerOf(await r.get(WIDGETS))).audience).toBe("maintainer")
  })

  test("Postgres down is 503 unavailable on another repository; the deployment's own needs no Postgres", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "admin")
    const r = await route({ sessions: signedIn(person("member")), files: WIDGETS_HOME, github, database: unreachable })
    const response = await r.get(WIDGETS)
    expect([response.status, await response.json()]).toEqual([503, { code: "unavailable" }])
    expect((await answerOf(await r.get(EFFECT))).audience).toBe("contributor")
  })
})

describe("GET /api/repos/<owner>/<name>/role (decision 0079)", () => {
  const ROLE_EFFECT = "/api/repos/Effect-TS/effect/role"
  const ROLE_WIDGETS = "/api/repos/acme/widgets/role"
  const roleOf = async (response: Response) => [response.status, await response.json()]

  test("the session's role on the deployment's own repository, which it says is its own; signed out, none", async () => {
    const r = await route({ sessions: signedIn(person("maintainer")) })
    const response = await r.get(ROLE_EFFECT)
    expect([response.headers.get("cache-control"), response.headers.get("vary")]).toEqual(["no-store", "cookie"])
    expect(await roleOf(response)).toEqual([200, { role: "maintainer", own: true }])
    expect(await roleOf(await (await route()).get(ROLE_EFFECT))).toEqual([200, { role: null, own: true }])
    expect(r.logs.find((log) => log.message === "repo.role")).toMatchObject({
      level: "INFO",
      annotations: { outcome: "answered", role: "maintainer", own: true, source: "role", status: 200 },
    })
    expect(r.roleCount({ outcome: "answered", role: "maintainer" })).toBe(1)
    expect(r.spans.map((span) => span.name)).toEqual(["repo.role", "github.repo_role"])
  })

  test("on another repository the App is installed on, GitHub's permission there; never the deployment's role", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "read")
    const r = await route({ sessions: signedIn(person("admin")), github })
    expect(await roleOf(await r.get(ROLE_WIDGETS))).toEqual([200, { role: "guest", own: false }])
    github.roles.set("maya", "maintain")
    await sql(runtime, `TRUNCATE github_repo_roles`)
    expect(await roleOf(await r.get(ROLE_WIDGETS))).toEqual([200, { role: "maintainer", own: false }])
  })

  test("where the deployment can't act, no role; GitHub failing is its refusal with a wait; sessions down 503", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "admin")
    github.installed = false
    const notInstalled = await route({ sessions: signedIn(person("admin")), github })
    expect(await roleOf(await notInstalled.get(ROLE_WIDGETS))).toEqual([200, { role: null, own: false }])
    expect(notInstalled.logs.find((log) => log.message === "repo.role")).toMatchObject({
      annotations: { outcome: "answered", role: null, source: "no_role_here", refused: "app_not_installed" },
    })
    expect(notInstalled.roleCount({ outcome: "answered", role: "no_role" })).toBe(1)
    github.installed = true
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 429, headers: { "retry-after": "12" } })
    const limited = await (await route({ sessions: signedIn(person("admin")), github })).get(ROLE_WIDGETS)
    expect([limited.status, limited.headers.get("retry-after"), await limited.json()]).toEqual([429, "12", { code: "rate_limited" }])
    const down = await route({ sessions: unavailable })
    const response = await down.get(ROLE_EFFECT)
    expect([response.status, response.headers.get("retry-after"), await response.json()]).toEqual([503, "5", { code: "unavailable" }])
    expect(down.logs.find((log) => log.message === "repo.role")).toMatchObject({ level: "WARN", annotations: { outcome: "unavailable" } })
    expect(down.roleCount({ outcome: "unavailable", role: "none" })).toBe(1)
  })

  test("the answer says whether the deployment syncs the repository's issues and pull requests (decision 0079 slice 1b)", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "read")
    // The GitHub routes' rule, given: every repository but acme/widgets.
    const maySync = (target: ReturnType<typeof repositoryOf>) => Effect.succeed(target.id !== "github/acme/widgets")
    const r = await route({ sessions: signedIn(person("member")), github, maySync })
    expect(await roleOf(await r.get(ROLE_EFFECT))).toEqual([200, { role: "member", own: true, synced: true }])
    expect(await roleOf(await r.get(ROLE_WIDGETS))).toEqual([200, { role: "guest", own: false, synced: false }])
    expect(await roleOf(await (await route({ maySync })).get(ROLE_WIDGETS))).toEqual([200, { role: null, own: false, synced: false }])
  })

  test("only GET", async () => {
    const r = await route()
    const response = await r.get(ROLE_EFFECT, { method: "POST" })
    expect([response.status, response.headers.get("allow")]).toEqual([405, "GET"])
    expect(r.roleCount({ outcome: "method", role: "none" })).toBe(1)
  })
})

describe("the home route's path", () => {
  test("names a repository's home, and nothing else", () => {
    expect(parseHomePath("/api/repos/Effect-TS/effect/home")).toEqual({ owner: "Effect-TS", name: "effect" })
    expect(parseHomePath("/api/repos/a%2Db/c.d/home")).toEqual({ owner: "a-b", name: "c.d" })
    for (const path of [
      "/api/repos/Effect-TS/effect",
      "/api/repos/Effect-TS/effect/home/x",
      "/api/repos/Effect-TS/effect/stack",
      "/api/repos/Effect-TS/home",
      "/api/repositories/a/b/home",
      "/api/repos/-bad/x/home",
      "/api/repos/%E0%A4%A/x/home",
    ]) {
      expect([path, parseHomePath(path), handles(path)]).toEqual([path, undefined, false])
    }
    expect(handles("/api/repos/maya/tinyhttp/home")).toBe(true)
    // The role route beside it.
    expect(parseRolePath("/api/repos/Effect-TS/effect/role")).toEqual({ owner: "Effect-TS", name: "effect" })
    expect(parseRolePath("/api/repos/Effect-TS/effect/home")).toBeUndefined()
    expect(handles("/api/repos/Effect-TS/effect/role")).toBe(true)
    expect(handles("/api/repos/Effect-TS/effect/role/x")).toBe(false)
  })
})

describe("the curated homes", () => {
  test("every file reads as a home, skips nothing, and its repository is unique", () => {
    const names = Curated.files.map((file) => file.repository.toLowerCase())
    expect(new Set(names).size).toBe(names.length)
    for (const file of Curated.files) {
      const read = Home.read(JSON.stringify(file.home))
      expect([file.repository, read._tag, read._tag === "Declared" ? read.skipped : null]).toEqual([
        file.repository,
        "Declared",
        0,
      ])
      expect(file.defaultBranch).not.toBe("")
    }
  })

  test("Effect's home: a landing page for everyone, work for contributors, and the day for Maintainers", () => {
    const effect = Curated.find("Effect-TS", "effect")
    if (effect === undefined || effect === "invalid") throw new Error("Effect's curated home doesn't read")
    const kinds = (audience: Home.Audience) =>
      effect.sections.filter((section) => section.audience === audience).flatMap((section) => section.blocks.map((block) => block.type))
    expect(kinds("everyone")).toEqual(["hero", "code", "stats", "cards", "cards", "cards", "releases", "links", "prompt"])
    expect(kinds("contributor")).toEqual(["prompt", "stack", "flows", "app", "app"])
    expect(kinds("maintainer")).toEqual(["action", "issues", "runs"])
  })

  test("find: none for a repository it doesn't hold, and invalid for a file that isn't a home", () => {
    expect(Curated.find("octocat", "Spoon-Knife")).toBeUndefined()
    const files = [{ repository: "a/b", defaultBranch: "main", home: { blocks: [{ type: "board" }] } }]
    // A kind this reader doesn't know is skipped in a repository's own home; in a curated one it is a mistake.
    expect(Curated.find("a", "b", files)).toBe("invalid")
    expect(Curated.find("a", "b", [{ ...files[0]!, home: "not a home" }])).toBe("invalid")
  })
})
