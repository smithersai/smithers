// Who may ask Smithers (ruling AUTH-8, decision 0122): anyone signed in, in a conversation on a repository where they
// are a Member or above, by GitHub's permission for them there, never by their role on the deployment's own
// repository. ChatApi's real handler on this file's schema of the compose Postgres, with the real `RepoRoles` reading
// roles through the App from a scripted GitHub (worker/github/test/scriptedGitHub.ts), the one stand-in: asking, the
// answer routes, the views route and the runs route, each on a branch of acme/widgets, where the App is installed.
import { Effect, Option, type Redacted, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import type { Actor, Role } from "./Actor.ts"
import { BranchRoles } from "./branch/Access.ts"
import * as ChatMetrics from "./ChatMetrics.ts"
import { repositoryOf } from "./github/Config.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import { reset, sql } from "./github/test/fixtures.ts"
import { app } from "./github/test/harness.ts"
import { accountIdOf, appKey, INSTALLATION_ID, scriptedGitHub, type ScriptedGitHub } from "./github/test/scriptedGitHub.ts"
import { resetBranches, shared, tracked } from "./test/branch.ts"
import { harness, testFile, uuid } from "./test/harness.ts"

const runtime = testFile("who-may-ask")

/** Maya as sign-in recorded her: her person id, login and GitHub account (the one the scripted GitHub gives her). */
const MAYA = "6d0e3a2b-9d4f-4b6c-8e1a-2f3b4c5d6e70"
const WIDGETS = "github/acme/widgets"

/** Maya, with `role` on the deployment's own repository (acme/home): the session's role. */
const maya = (role: Role | null): Actor => ({ subject: { kind: "person", id: MAYA }, role, login: "maya" })

let key: Redacted.Redacted<string> | undefined

/** `BranchRoles` over the real `RepoRoles`: the deployment's own repository acme/home, the App over `github`. */
const withApp = async (github: ScriptedGitHub) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  key ??= await appKey()
  const roles = await runtime.runPromise(RepoRoles.make(scratch.database, {
    repository: repositoryOf("acme/home"),
    app: Option.some(app({ privateKey: key })),
    http: github.http,
  }))
  return BranchRoles.layer(roles)
}

/**
 * ChatApi as `actor`, with Maya's GitHub permission on acme/widgets `permission` (none when unset), and the team's
 * branch of acme/widgets, which anyone in the repository with the link may edit: its conversation's id.
 */
const open = async (actor: Actor | null, permission?: "admin" | "maintain" | "write" | "triage" | "read") => {
  const github = scriptedGitHub("acme", "widgets")
  if (permission !== undefined) github.roles.set("maya", permission)
  const branch = await tracked(runtime, WIDGETS, "main")
  await shared(runtime, branch.branchId, "repository", "edit")
  const h = await harness(runtime, () => Stream.empty, {
    ...(actor === null ? {} : { actor }),
    branchRoles: await withApp(github),
  })
  return { h, github, conversationId: branch.conversationId }
}

type Opened = Awaited<ReturnType<typeof open>>

const question = (conversationId: string) => ({ id: uuid(), answerId: uuid(), conversationId, text: "What does this repository do?" })

const json = async (response: Response) => [response.status, await response.json()] as const

const messages = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client`SELECT id FROM messages`))

beforeEach(async () => {
  await resetBranches(runtime)
  await reset(runtime)
  await sql(runtime, `INSERT INTO people (id, github_id, github_login) VALUES ('${MAYA}', ${accountIdOf("maya")}, 'maya')`)
  await sql(runtime, `INSERT INTO github_repositories (repo_id, installation_id) VALUES ('${WIDGETS}', ${INSTALLATION_ID})`)
})

describe("asking", () => {
  test.each([
    ["admin", "admin"],
    ["maintain", "maintainer"],
    ["write", "member"],
  ] as const)("GitHub's %s on acme/widgets (%s there) asks in its conversation, holding no role on the deployment's own", async (permission, role) => {
    const { h, github, conversationId } = await open(maya(null), permission)
    expect((await h.ask(question(conversationId))).status).toBe(202)
    // Decided by GitHub's permission there, read once and kept, never by the session's role.
    expect(github.seen("GET", /\/repos\/acme\/widgets\/collaborators\/maya\/permission$/)).toHaveLength(1)
    expect(h.only("chat.question").annotations).toMatchObject({ status: 202, role })
  })

  test.each([
    ["a Guest there (GitHub read)", "read" as const],
    ["a Guest there (GitHub triage)", "triage" as const],
    ["someone GitHub knows no role for there", undefined],
  ])("%s is 403, and nothing is written", async (_, permission) => {
    const { h, conversationId } = await open(maya(null), permission)
    const response = await h.ask(question(conversationId))
    expect(await json(response)).toEqual([403, { message: "Asking Smithers needs the Member role." }])
    expect(await messages()).toEqual([])
    expect(h.count(ChatMetrics.questions, { status: "403" })).toBe(1)
    expect(h.only("chat.question").annotations).toMatchObject({ status: 403, errorCode: "forbidden", role: permission === undefined ? "none" : "guest" })
  })

  test("the deployment's own Admin who only reads acme/widgets has no more power there than any Guest", async () => {
    const { h, conversationId } = await open(maya("admin"), "read")
    expect(await json(await h.ask(question(conversationId)))).toEqual([403, { message: "Asking Smithers needs the Member role." }])
    expect(await messages()).toEqual([])
  })

  test("signed out is 401, asking GitHub nothing", async () => {
    const { h, github, conversationId } = await open(null, "admin")
    expect(await json(await h.ask(question(conversationId)))).toEqual([401, { message: "Sign in to ask Smithers." }])
    expect(github.calls).toEqual([])
  })

  test("the deployment's home conversation is its own Members', so a Member of acme/widgets who isn't one may not ask there", async () => {
    const { h } = await open(maya(null), "admin")
    expect(await json(await h.ask({ id: uuid(), answerId: uuid(), text: "Hello" }))).toEqual([
      403,
      { message: "Asking Smithers needs the Member role." },
    ])
  })
})

describe("what an asker does in the conversation after", () => {
  /** Maya asks in acme/widgets' conversation as a Member there: the answer's id, which is its run's. */
  const asked = async (opened: Opened) => {
    const asking = question(opened.conversationId)
    expect((await opened.h.ask(asking)).status).toBe(202)
    return asking.answerId
  }

  /** GitHub says `permission` for Maya there from now on, read again at once. */
  const nowOnGitHub = async (opened: Opened, permission: "write" | "read") => {
    opened.github.roles.set("maya", permission)
    await sql(runtime, `TRUNCATE github_repo_roles`)
  }

  test("her answer's turn and writes, while she is a Member there; once GitHub says read, 403", async () => {
    const opened = await open(maya(null), "write")
    const answerId = await asked(opened)
    expect((await opened.h.fetch(`/api/answers/${answerId}`)).status).toBe(200)
    await nowOnGitHub(opened, "read")
    expect(await json(await opened.h.fetch(`/api/answers/${answerId}`))).toEqual([403, { code: "forbidden" }])
    const write = await opened.h.fetch(`/api/answers/${answerId}`, { method: "POST", body: JSON.stringify({ status: "done", text: "No" }) })
    expect(await json(write)).toEqual([403, { code: "forbidden" }])
    expect(opened.h.line("chat.answer.turn").at(-1)?.annotations).toMatchObject({ status: 403, errorCode: "forbidden" })
  })

  test("a view added to the conversation, while she is a Member there; once GitHub says read, 403", async () => {
    const opened = await open(maya(null), "write")
    const view = (id = uuid()) => ({ id, template: "webpage", props: { url: "https://example.com/" }, conversationId: opened.conversationId })
    const add = (body: unknown) => opened.h.fetch("/api/views", { method: "POST", body: JSON.stringify(body) })
    expect((await add(view())).status).toBe(202)
    await nowOnGitHub(opened, "read")
    expect(await json(await add(view()))).toEqual([403, { code: "forbidden" }])
    expect(opened.h.line("chat.view.add").at(-1)?.annotations).toMatchObject({ status: 403, reason: "forbidden" })
  })

  test("her run's status reports, while she is a Member there; once GitHub says read, 403", async () => {
    const opened = await open(maya(null), "write")
    const runId = await asked(opened)
    const report = () => opened.h.fetch(`/api/runs/${runId}`, { method: "POST", body: JSON.stringify({ status: "working" }) })
    expect((await report()).status).toBe(200)
    await nowOnGitHub(opened, "read")
    expect(await json(await report())).toEqual([403, { code: "forbidden" }])
    expect(opened.h.line("agent.status.report").at(-1)?.annotations).toMatchObject({ status: 403, errorCode: "forbidden" })
  })
})
