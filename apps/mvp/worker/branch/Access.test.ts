// Who may do what on a branch's live workspace (worker/branch/Access.ts, decision 0013 §2 and §4): Google Docs-style
// sharing on this file's schema of the compose Postgres (`pnpm db:up`). A branch is private to its creator until they
// share it with people by name, to view or edit, or with anyone in the repository who has the link, Members only.
// Every check decides with the person's role on the branch's own repository (decision 0079), from the real `RepoRoles`
// over the scripted GitHub where the App is installed; elsewhere the session's role.
import { Effect, Exit, Layer, Option, type Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import type { Actor, Role } from "../Actor.ts"
import { repositoryOf } from "../github/Config.ts"
import * as RepoRoles from "../github/RepoRoles.ts"
import { reset, sql } from "../github/test/fixtures.ts"
import { app } from "../github/test/harness.ts"
import { accountIdOf, appKey, INSTALLATION_ID, type ScriptedGitHub, scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import { resetBranches, shared, tracked } from "../test/branch.ts"
import { branchRoles, testFile } from "../test/harness.ts"
import {
  accessOf,
  askingOf,
  askingOnAnswer,
  branchAccess as branchAccessIn,
  branchAccessAs,
  BranchRoles,
  canEdit,
  canView,
  ceilingOf,
  type Grants,
  installedOn,
  isMember,
  isMemberOn,
  policyOf,
  roleOn,
  underPolicy,
} from "./Access.ts"

const runtime = testFile("access")
beforeEach(async () => {
  await resetBranches(runtime)
  await reset(runtime)
})

/** `BranchRoles` as a deployment without the App gives them: the session's role on every repository. */
const withoutApp = async () => branchRoles((await runtime.runPromise(Effect.service(TestDatabase.Scratch))).database)

/** `branchAccess` with `BranchRoles` as a deployment without the App gives them. */
const branchAccess = (actor: Option.Option<Actor>, id: string, by?: "branch" | "conversation") =>
  Effect.gen(function* () {
    return yield* branchAccessIn(actor, id, by).pipe(Effect.provide(yield* Effect.promise(withoutApp)))
  })

const REPO = "github/octocat/spoon-knife"

const person = (role: Role | null, id = "person-1"): Option.Option<Actor> =>
  Option.some({ subject: { kind: "person", id }, role })

const grants = (fields: Partial<Grants> = {}): Grants => ({ createdBy: null, person: null, repository: null, ...fields })

describe("ceilingOf", () => {
  test("a Member or above may edit, a Guest only view, and no role nothing", () => {
    for (const role of ["admin", "maintainer", "member"] as const) expect(ceilingOf(role)).toBe("edit")
    expect(ceilingOf("guest")).toBe("view")
    expect(ceilingOf(null)).toBe("none")
  })
})

describe("accessOf", () => {
  test("a branch is its creator's: they own it, and nobody else sees it until it is shared", () => {
    expect(accessOf(person("member"), grants({ createdBy: "person-1" }))).toBe("owner")
    expect(accessOf(person("admin", "person-2"), grants({ createdBy: "person-1" }))).toBe("none")
    expect(accessOf(person("maintainer", "person-2"), grants({ createdBy: "person-1" }))).toBe("none")
  })

  test("a share by name grants view or edit, never above the person's role", () => {
    expect(accessOf(person("member"), grants({ createdBy: "x", person: "view" }))).toBe("view")
    expect(accessOf(person("member"), grants({ createdBy: "x", person: "edit" }))).toBe("edit")
    expect(accessOf(person("guest"), grants({ createdBy: "x", person: "view" }))).toBe("view")
    // A Guest shared to edit still only views: GitHub gives them no write.
    expect(accessOf(person("guest"), grants({ createdBy: "x", person: "edit" }))).toBe("view")
  })

  test("the link reaches Members and above, never a Guest", () => {
    expect(accessOf(person("member"), grants({ createdBy: "x", repository: "view" }))).toBe("view")
    expect(accessOf(person("admin"), grants({ createdBy: "x", repository: "edit" }))).toBe("edit")
    expect(accessOf(person("guest"), grants({ createdBy: "x", repository: "edit" }))).toBe("none")
  })

  test("the better of a share and the link wins", () => {
    expect(accessOf(person("member"), grants({ createdBy: "x", person: "view", repository: "edit" }))).toBe("edit")
    expect(accessOf(person("member"), grants({ createdBy: "x", person: "edit", repository: "view" }))).toBe("edit")
    expect(accessOf(person("guest"), grants({ createdBy: "x", person: "view", repository: "edit" }))).toBe("view")
  })

  test("the signed out, a person with no role, and a creator demoted to Guest get nothing of their own", () => {
    expect(accessOf(Option.none(), grants({ repository: "edit" }))).toBe("none")
    expect(accessOf(person(null), grants({ createdBy: "person-1", person: "edit", repository: "edit" }))).toBe("none")
    expect(accessOf(person("guest"), grants({ createdBy: "person-1" }))).toBe("none")
    expect(accessOf(person("guest"), grants({ createdBy: "person-1", person: "view" }))).toBe("view")
  })
})

describe("canView and canEdit", () => {
  test("view and up open a branch; owner and edit write to it", () => {
    expect([canView("owner"), canView("edit"), canView("view"), canView("none")]).toEqual([true, true, true, false])
    expect([canEdit("owner"), canEdit("edit"), canEdit("view"), canEdit("none")]).toEqual([true, true, false, false])
  })
})

describe("underPolicy", () => {
  test("applies a whole permission list to one principal and role", () => {
    const policy = { createdBy: "owner", grants: { ben: "edit", gus: "view", repository: "view" } } as const
    expect(underPolicy(policy, "owner", "member")).toBe("owner")
    expect(underPolicy(policy, "ben", "member")).toBe("edit")
    expect(underPolicy(policy, "gus", "guest")).toBe("view")
    expect(underPolicy(policy, "maya", "member")).toBe("view")
    expect(underPolicy(policy, "stranger", "guest")).toBe("none")
    expect(underPolicy({ createdBy: null, grants: {} }, "maya", "admin")).toBe("none")
    // A grant can't be read off a key every object has.
    expect(underPolicy({ createdBy: null, grants: {} }, "constructor", "member")).toBe("none")
  })
})

describe("isMember", () => {
  test("is a signed-in Member or above", () => {
    expect(isMember(person("member"))).toBe(true)
    expect(isMember(person("guest"))).toBe(false)
    expect(isMember(person(null))).toBe(false)
    expect(isMember(Option.none())).toBe(false)
  })
})

describe("branchAccess and policyOf", () => {
  test("read the branch, its conversation and the asker's access, by branch or by conversation", async () => {
    const branch = await tracked(runtime, REPO, "feature/share", "open", "person-1")
    const owner = await runtime.runPromise(branchAccess(person("member"), branch.branchId))
    expect(owner).toEqual({ ...branch, createdBy: "person-1", access: "owner", role: "member", shared: false })
    const byConversation = await runtime.runPromise(branchAccess(person("member"), branch.conversationId, "conversation"))
    expect(byConversation).toEqual(owner)
    expect(await runtime.runPromise(branchAccess(person("member", "person-2"), branch.branchId)))
      .toMatchObject({ access: "none" })
    expect(await runtime.runPromise(branchAccess(Option.none(), branch.branchId))).toMatchObject({ access: "none" })
  })

  test("a share and the link reach the people they name", async () => {
    const branch = await tracked(runtime, REPO, "feature/shared", "open", "person-1")
    await shared(runtime, branch.branchId, "person-2", "edit", "ben")
    await shared(runtime, branch.branchId, "person-3", "view", "gus")
    // Shared: its owner and everyone it names see it so.
    expect(await runtime.runPromise(branchAccess(person("member", "person-1"), branch.branchId)))
      .toMatchObject({ access: "owner", shared: true })
    expect(await runtime.runPromise(branchAccess(person("member", "person-2"), branch.branchId)))
      .toMatchObject({ access: "edit", shared: true })
    expect(await runtime.runPromise(branchAccess(person("guest", "person-3"), branch.branchId)))
      .toMatchObject({ access: "view" })
    expect(await runtime.runPromise(branchAccess(person("member", "person-4"), branch.branchId)))
      .toMatchObject({ access: "none" })
    await shared(runtime, branch.branchId, "repository", "view")
    expect(await runtime.runPromise(branchAccess(person("member", "person-4"), branch.branchId)))
      .toMatchObject({ access: "view" })
    // `repository` names the link's grant, never a person who might share its id.
    expect(await runtime.runPromise(branchAccess(person("guest", "repository"), branch.branchId)))
      .toMatchObject({ access: "none" })
    expect(await runtime.runPromise(policyOf(branch.branchId))).toEqual({
      createdBy: "person-1",
      grants: { "person-2": "edit", "person-3": "view", repository: "view" },
    })
  })

  test("a team branch (no creator, or the default branch) is open to Members with the link to edit", async () => {
    const team = await tracked(runtime, REPO, "team")
    const main = await tracked(runtime, REPO, "main", "locked", "person-1")
    for (const branch of [team, main]) {
      // Nobody shared the team's: their link's grant is the team's own.
      expect(await runtime.runPromise(branchAccess(person("member"), branch.branchId)))
        .toMatchObject({ createdBy: null, access: "edit", shared: false })
      expect(await runtime.runPromise(branchAccess(person("guest"), branch.branchId))).toMatchObject({ access: "none" })
    }
    expect(await runtime.runPromise(policyOf(main.branchId))).toEqual({
      createdBy: null,
      grants: { repository: "edit" },
    })
  })

  test("no such branch, or conversation, is undefined; a branch no one tracks has an empty policy", async () => {
    expect(await runtime.runPromise(branchAccess(person("member"), crypto.randomUUID()))).toBeUndefined()
    expect(await runtime.runPromise(branchAccess(person("member"), crypto.randomUUID(), "conversation")))
      .toBeUndefined()
    expect(await runtime.runPromise(policyOf(crypto.randomUUID()))).toEqual({ createdBy: null, grants: {} })
  })
})

describe("roles per repository (decision 0079)", () => {
  /** Maya as sign-in recorded her: her person id, login and GitHub account (the one the scripted GitHub gives her). */
  const MAYA = "5c7e3a2b-9d4f-4b6c-8e1a-2f3b4c5d6e7f"
  const WIDGETS = "github/acme/widgets"
  const maya = (role: Role | null): Option.Option<Actor> => Option.some({ subject: { kind: "person", id: MAYA }, role, login: "maya" })
  let key: Redacted.Redacted<string> | undefined

  /** `BranchRoles` over the real `RepoRoles`, the deployment's own repository acme/home, the App over `github`. */
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
  const installed = () => sql(runtime, `INSERT INTO github_repositories (repo_id, installation_id) VALUES ('${WIDGETS}', ${INSTALLATION_ID})`)
  const run = <A, E>(effect: Effect.Effect<A, E, BranchRoles | SqlClient.SqlClient>, roles: Layer.Layer<BranchRoles>) =>
    runtime.runPromise(effect.pipe(Effect.provide(roles)))

  beforeEach(() => sql(runtime, `INSERT INTO people (id, github_id, github_login) VALUES ('${MAYA}', ${accountIdOf("maya")}, 'maya')`))

  test.each([
    ["admin", "admin", "edit"],
    ["maintain", "maintainer", "edit"],
    ["write", "member", "edit"],
    ["triage", "guest", "none"],
    ["read", "guest", "none"],
  ] as const)("on a repository the App is installed on, GitHub's %s there (%s) decides the team branch: %s", async (permission, role, access) => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", permission)
    await installed()
    const branch = await tracked(runtime, WIDGETS, "main")
    await shared(runtime, branch.branchId, "repository", "edit")
    // A Guest of the deployment's own repository: only her permission on acme/widgets counts on its branches.
    const found = await run(branchAccessIn(maya("guest"), branch.branchId), await withApp(github))
    expect([found?.access, found?.role]).toEqual([access, role])
    expect(github.seen("GET", /\/collaborators\/maya\/permission$/)).toHaveLength(1)
  })

  test("a role on the deployment's repository never opens a branch of another the App is installed on", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "read")
    await installed()
    const branch = await tracked(runtime, WIDGETS, "main")
    await shared(runtime, branch.branchId, "repository", "edit")
    const roles = await withApp(github)
    // The deployment's Admin, a reader on acme/widgets: a Guest there, whom the link doesn't reach.
    expect(await run(branchAccessIn(maya("admin"), branch.branchId), roles)).toMatchObject({ access: "none", role: "guest" })
    // Shared with her by name to edit, she may only view: GitHub gives her no write there.
    await shared(runtime, branch.branchId, MAYA, "edit", "maya")
    expect(await run(branchAccessIn(maya("admin"), branch.branchId), roles)).toMatchObject({ access: "view", role: "guest" })
    expect(await run(isMemberOn(maya("admin"), WIDGETS), roles)).toBe(false)
    // No account GitHub knows there: nothing at all.
    github.roles.delete("maya")
    await sql(runtime, `TRUNCATE github_repo_roles`)
    expect(await run(branchAccessIn(maya("admin"), branch.branchId), roles)).toMatchObject({ access: "none", role: null })
  })

  test("a repository Smithers hasn't recorded the App on keeps the session's role, asking GitHub nothing", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "read")
    const branch = await tracked(runtime, WIDGETS, "main")
    await shared(runtime, branch.branchId, "repository", "edit")
    const roles = await withApp(github)
    expect(await run(branchAccessIn(maya("member"), branch.branchId), roles)).toMatchObject({ access: "edit", role: "member" })
    expect(await run(isMemberOn(maya("member"), WIDGETS), roles)).toBe(true)
    expect(await run(installedOn(WIDGETS), roles)).toBe(false)
    expect(github.calls).toEqual([])
    // Signed out asks no one either.
    expect(await run(branchAccessIn(Option.none(), branch.branchId), roles)).toMatchObject({ access: "none", role: null })
    expect(await run(isMemberOn(Option.none(), WIDGETS), roles)).toBe(false)
  })

  test("GitHub or Postgres not answering is the refusal, never a guessed role", async () => {
    const github = scriptedGitHub("acme", "widgets")
    github.roles.set("maya", "admin")
    await installed()
    const branch = await tracked(runtime, WIDGETS, "main")
    github.faults.push({ match: (_, path) => path.endsWith("/permission"), status: 502 })
    const failed = await runtime.runPromiseExit(branchAccessIn(maya("admin"), branch.branchId).pipe(Effect.provide(await withApp(github))))
    expect(Exit.isFailure(failed) && JSON.stringify(failed.cause)).toContain("github_unavailable")
    // Asked again, GitHub answers.
    expect(await run(roleOn(Option.getOrThrow(maya(null)), WIDGETS, true), await withApp(github))).toBe("admin")
  })

  test("a repository Smithers hasn't recorded the App on takes BranchRoles' uninstalled role when it has one", async () => {
    const branch = await tracked(runtime, WIDGETS, "main")
    await shared(runtime, branch.branchId, "repository", "edit")
    const asked: Array<string> = []
    const local = Layer.succeed(BranchRoles, BranchRoles.of({
      roleOn: () => Effect.die("never asked: the App isn't recorded there"),
      uninstalled: (_, repoId) => {
        asked.push(repoId)
        return "admin"
      },
    }))
    expect(await run(branchAccessIn(maya(null), branch.branchId), local)).toMatchObject({ access: "edit", role: "admin" })
    expect(asked).toEqual([WIDGETS])
    // A BranchRoles with no uninstalled role keeps the session's.
    const plain = Layer.succeed(BranchRoles, BranchRoles.of({ roleOn: () => Effect.die("never asked: the App isn't recorded there") }))
    expect(await run(branchAccessIn(maya("member"), branch.branchId), plain)).toMatchObject({ access: "edit", role: "member" })
  })

  test("branchAccessAs decides with the role the actor carries, asking no one", async () => {
    const branch = await tracked(runtime, WIDGETS, "main")
    await shared(runtime, branch.branchId, "repository", "edit")
    await installed()
    expect(await runtime.runPromise(branchAccessAs(maya("member"), branch.branchId))).toMatchObject({ access: "edit", role: "member" })
    expect(await runtime.runPromise(branchAccessAs(maya("guest"), branch.branchId, "branch"))).toMatchObject({ access: "none" })
    expect(await runtime.runPromise(branchAccessAs(maya("member"), crypto.randomUUID()))).toBeUndefined()
  })
})

describe("who may ask in a conversation (ruling AUTH-8)", () => {
  const found = (role: Role | null, access: "owner" | "edit" | "view" | "none") =>
    ({ branchId: "b", conversationId: "c", repoId: REPO, name: "main", mode: "open", createdBy: null, access, role, shared: false }) as const

  test("a Member or above there who may edit asks; one who may not only views; anyone below Member there is refused", () => {
    for (const role of ["admin", "maintainer", "member"] as const) {
      expect([askingOf(found(role, "owner")), askingOf(found(role, "edit")), askingOf(found(role, "view")), askingOf(found(role, "none"))], role)
        .toEqual(["ask", "ask", "view_only", "view_only"])
    }
    expect([askingOf(found("guest", "view")), askingOf(found(null, "none"))]).toEqual(["forbidden", "forbidden"])
  })

  test("askingOnAnswer reads the answer's conversation: none for no message, forbidden once its branch is deleted", async () => {
    const branch = await tracked(runtime, REPO, `ask-${crypto.randomUUID().slice(0, 8)}`)
    await shared(runtime, branch.branchId, "repository", "edit")
    const answerId = crypto.randomUUID()
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) =>
      client`INSERT INTO messages (id, role, text, status, conversation_id) VALUES (${answerId}, 'user', 'Hello', 'done', ${branch.conversationId})`))
    const roles = await withoutApp()
    const on = (actor: Actor, id = answerId) => runtime.runPromise(askingOnAnswer(actor, id).pipe(Effect.provide(roles)))
    expect(await on(Option.getOrThrow(person("member")))).toBe("ask")
    expect(await on(Option.getOrThrow(person("guest")))).toBe("forbidden")
    expect(await on(Option.getOrThrow(person("member")), crypto.randomUUID())).toBeUndefined()
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) =>
      client`UPDATE branches SET deleted_at = now() WHERE id = ${branch.branchId}`))
    expect(await on(Option.getOrThrow(person("member")))).toBe("forbidden")
  })
})
