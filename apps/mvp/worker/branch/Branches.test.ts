// `POST /api/branches` (worker/branch/Branches.ts, decision 0013 §2) through the branch workspace's real routes
// (worker/test/branch.ts) on this file's schema of the compose Postgres (`pnpm db:up`), with GitHub scripted at the
// network: a branch is recorded only once its forge, `Forge.layerConfig` as production builds it, says GitHub has it.
import { Uuid, WebCrypto } from "@smthrs/crypto"
import { Effect, Layer, Option, Redacted } from "effect"
import { HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as Flows from "../Flows.ts"
import * as Database from "../../db/Database.ts"
import { CONVERSATION_NAMESPACE, MAX_TRACK_BODY_BYTES } from "../../src/features/branch/contract.ts"
import { type Actor, Sessions, SessionsUnavailable } from "../Actor.ts"
import { branchHarness, type BranchHarness, gitHost, resetBranches, shaOf, shared, tracked } from "../test/branch.ts"
import { recorded, testFile } from "../test/harness.ts"
import * as RepoRoles from "../github/RepoRoles.ts"
import { BranchRoles } from "./Access.ts"
import * as Branches from "./Branches.ts"
import * as Conversations from "./Conversations.ts"
import { CreateRefused, Forge } from "./Forge.ts"

const runtime = testFile("branches")
beforeEach(() => resetBranches(runtime))

const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }

/** A branch name no record may carry. */
const SENTINEL = "feature/sentinel-7f3a"

/** GitHub with `octocat/Spoon-Knife`: `main` (its default), `feature/sentinel-7f3a` and `feature`. */
const github = () => {
  const host = gitHost()
  host.publish("octocat", "Spoon-Knife", {
    defaultBranch: "main",
    branches: { main: shaOf("main"), [SENTINEL]: shaOf(SENTINEL), feature: shaOf("feature") },
  })
  host.publish("octocat", "secret", { defaultBranch: "main", branches: { main: shaOf("secret") }, private: true })
  return host
}

const open = (options: Parameters<typeof branchHarness>[1] = {}) =>
  branchHarness(runtime, { actor: member, github: github(), ...options })

const track = (h: BranchHarness, body: unknown, init: RequestInit = {}) =>
  h.fetch("/api/branches", {
    method: "POST",
    body: (typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body)) as BodyInit,
    ...init,
  })

const json = async (response: Response) => [response.status, await response.json()]

const rows = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly id: string; readonly name: string; readonly mode: string; readonly baseSha: string | null; readonly conversationId: string }>`
      SELECT b.id, b.name, b.mode, b.base_sha AS "baseSha", c.id AS "conversationId"
      FROM branches b JOIN conversations c ON c.branch_id = b.id
      WHERE b.repo_id = 'github/octocat/spoon-knife' ORDER BY b.name`))

const conversationOf = (branchId: string) =>
  Effect.runPromise(Uuid.v5(CONVERSATION_NAMESPACE, branchId).pipe(Effect.provide(WebCrypto.layer)))

describe("POST /api/branches", () => {
  test("records a branch GitHub has, with its conversation, 201; tracking it again answers it at once, 200", async () => {
    const h = await open()

    const first = await track(h, { owner: "OctoCat", name: "Spoon-Knife", ref: SENTINEL })

    expect(first.status).toBe(201)
    expect(first.headers.get("cache-control")).toBe("no-store")
    const branch = await first.json() as { readonly branchId: string; readonly conversationId: string }
    expect(branch).toEqual({
      branchId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      conversationId: await conversationOf(branch.branchId),
      repoId: "github/octocat/spoon-knife",
      name: SENTINEL,
      mode: "open",
      access: "owner",
      shared: false,
    })
    expect(await rows()).toEqual([
      { id: branch.branchId, name: SENTINEL, mode: "open", baseSha: shaOf(SENTINEL), conversationId: branch.conversationId },
    ])
    // One ls-refs for the one branch, then HEAD for the default branch; never a credential.
    expect(h.github.seen).toEqual([
      {
        method: "POST",
        path: "/OctoCat/Spoon-Knife.git/git-upload-pack",
        authorization: null,
        gitProtocol: "version=2",
        prefixes: [`refs/heads/${SENTINEL}`],
      },
      {
        method: "GET",
        path: "/OctoCat/Spoon-Knife.git/info/refs?service=git-upload-pack",
        authorization: null,
        gitProtocol: null,
        prefixes: [],
      },
    ])

    const again = await track(h, { owner: "octocat", name: "spoon-knife", ref: SENTINEL })
    expect(await json(again)).toEqual([200, branch])
    expect(h.github.seen).toHaveLength(2)

    expect(h.line("branch.track").map((line) => [line.level, line.annotations])).toEqual([
      [
        "INFO",
        expect.objectContaining({
          repoId: "github/octocat/spoon-knife",
          outcome: "tracked",
          mode: "open",
          access: "owner",
          status: 201,
        }),
      ],
      [
        "INFO",
        expect.objectContaining({ repoId: "github/octocat/spoon-knife", outcome: "existing", access: "owner", status: 200 }),
      ],
    ])
    expect(h.count(Branches.tracks, { outcome: "tracked" })).toBe(1)
    expect(h.count(Branches.tracks, { outcome: "existing" })).toBe(1)
    expect(h.span("branch.track")).toHaveLength(2)
    // The branch's name is someone's writing: no log line, span or metric carries it.
    expect(recorded(h)).not.toContain("sentinel-7f3a")
  })

  test("the repository's default branch is recorded locked; a name that only starts another branch's is not GitHub's", async () => {
    const h = await open()
    // The default branch is the team's: its tracker edits it as everyone does, and owns nothing.
    expect(await json(await track(h, { owner: "octocat", name: "Spoon-Knife", ref: "main" }))).toEqual([
      201,
      expect.objectContaining({ name: "main", mode: "locked", access: "edit", shared: false }),
    ])
    expect(await json(await track(h, { owner: "octocat", name: "Spoon-Knife", ref: "feat" }))).toEqual([
      404,
      { code: "not_found" },
    ])
    expect((await rows()).map((row) => [row.name, row.mode])).toEqual([["main", "locked"]])
    expect(h.line("branch.track").at(-1)).toMatchObject({
      level: "WARN",
      annotations: { forge: "ref_not_found", outcome: "not_found", status: 404 },
    })
  })

  test("a failed default-branch read refuses tracking without recording private ownership", async () => {
    const h = await open()
    h.github.fail("GET", new Response("", { status: 502 }))
    expect(await json(await track(h, { owner: "octocat", name: "Spoon-Knife", ref: "main" }))).toEqual([
      503,
      { code: "unavailable" },
    ])
  })

  test("a repository GitHub doesn't have, or keeps private, is 404 and records nothing; GITHUB_TOKEN is never sent", async () => {
    const h = await open({ config: { GITHUB_TOKEN: "ghp_sentinel-token" } })
    expect(await json(await track(h, { owner: "octocat", name: "gone", ref: "main" }))).toEqual([404, { code: "not_found" }])
    expect(await json(await track(h, { owner: "octocat", name: "secret", ref: "main" }))).toEqual([
      404,
      { code: "not_found" },
    ])
    expect(h.github.seen.map((seen) => [seen.path, seen.authorization])).toEqual([
      ["/octocat/gone.git/git-upload-pack", null],
      ["/octocat/secret.git/git-upload-pack", null],
    ])
    expect(h.line("branch.track").map((line) => line.annotations.forge)).toEqual(["not_found", "not_found"])
    expect(recorded(h)).not.toContain("ghp_sentinel-token")
    const all = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly n: number }>`SELECT count(*)::int AS n FROM branches WHERE repo_id LIKE 'github/octocat/%'`))
    expect(all).toEqual([{ n: 0 }])
  })

  test("GitHub failing or out of reach is 503 unavailable, by the forge's code, and records nothing", async () => {
    const h = await open()
    h.github.fail("POST", new Response("", { status: 500 }), "throw", new Response("<html>", { status: 200 }))
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await json(await track(h, { owner: "octocat", name: "Spoon-Knife", ref: "feature" }))).toEqual([
        503,
        { code: "unavailable" },
      ])
    }
    expect(h.line("branch.track").map((line) => [line.level, line.annotations.forge, line.annotations.outcome])).toEqual([
      ["ERROR", "unavailable", "unavailable"],
      ["ERROR", "transport", "unavailable"],
      ["ERROR", "invalid_response", "unavailable"],
    ])
    expect(h.count(Branches.tracks, { outcome: "unavailable" })).toBe(3)
    expect(await rows()).toEqual([])
  })

  test("one person tracking the same new branch twice at once records it once, and gets it both times", async () => {
    const h = await open()
    const release = h.github.hold()
    const both = [
      track(h, { owner: "octocat", name: "Spoon-Knife", ref: "feature" }),
      track(h, { owner: "octocat", name: "Spoon-Knife", ref: "feature" }),
    ]
    // Both have looked for the branch and found nothing before either reads GitHub's answer.
    await expect.poll(() => h.github.seen.length, { interval: 10, timeout: 5_000 }).toBe(2)
    release()
    const answered = await Promise.all(both.map(async (response) => json(await response)))

    expect(answered.map(([status]) => status).sort()).toEqual([200, 201])
    expect(answered[0]![1]).toEqual(answered[1]![1])
    expect(await rows()).toHaveLength(1)
    expect(h.line("branch.track").map((line) => line.annotations.outcome).sort()).toEqual(["existing", "tracked"])
  })

  test("refuses anything but a valid POST: 405, 400 invalid, 413", async () => {
    const h = await open()
    for (
      const body of [
        "not json",
        { owner: "octocat", name: "Spoon-Knife" },
        { owner: "-octocat", name: "Spoon-Knife", ref: "main" },
        { owner: "octocat", name: "Spoon Knife", ref: "main" },
        { owner: "octocat", name: "Spoon-Knife", ref: "a..b" },
        { owner: "octocat", name: "Spoon-Knife", ref: "-x" },
        { owner: "octocat", name: "Spoon-Knife", ref: "x.lock" },
        { owner: "octocat", name: "Spoon-Knife", ref: "" },
      ]
    ) {
      expect(await json(await track(h, body))).toEqual([400, { code: "invalid" }])
    }
    const large = await track(h, JSON.stringify({ owner: "octocat", name: "x", ref: "y".repeat(MAX_TRACK_BODY_BYTES) }))
    expect(await json(large)).toEqual([413, { code: "invalid" }])
    const broken = await track(h, new Uint8Array([0x7b, 0xff, 0xfe]))
    expect(await json(broken)).toEqual([400, { code: "invalid" }])
    const get = await h.fetch("/api/branches")
    expect([get.status, get.headers.get("allow")]).toEqual([405, "POST"])

    expect(h.line("branch.track").map((line) => line.annotations.outcome)).toEqual([
      ...Array(8).fill("invalid"),
      "invalid",
      "invalid",
      "method",
    ])
    expect(h.line("branch.track")[9]!.annotations).toMatchObject({ bytes: 3, status: 400 })
    expect(h.count(Branches.tracks, { outcome: "invalid" })).toBe(10)
    expect(h.count(Branches.tracks, { outcome: "method" })).toBe(1)
    expect(h.github.seen).toEqual([])
  })

  test("two people tracking one new branch at once: the first to record it owns it, and the other may not see it", async () => {
    const h = await open({
      sessions: Layer.succeed(Sessions, Sessions.of({
        // Each request says who it is with its own header, as two browsers' cookies would.
        resolve: Effect.map(
          Effect.service(HttpServerRequest.HttpServerRequest),
          (request) => Option.some({ ...member, subject: { kind: "person", id: request.headers["x-test-person"]! } }),
        ),
      })),
    })
    const release = h.github.hold()
    const both = ["person-a", "person-b"].map((person) =>
      track(h, { owner: "octocat", name: "Spoon-Knife", ref: "feature" }, { headers: { "x-test-person": person } })
    )
    await expect.poll(() => h.github.seen.length, { interval: 10, timeout: 5_000 }).toBe(2)
    release()
    const answered = await Promise.all(both.map(async (response) => json(await response)))
    expect(answered.map(([status]) => status).sort()).toEqual([201, 403])
    expect(answered.find(([status]) => status === 201)![1]).toMatchObject({ access: "owner" })
    expect(answered.find(([status]) => status === 403)![1]).toEqual({ code: "forbidden" })
    expect(await rows()).toHaveLength(1)
  })

  test("a branch someone else tracked is 403 until they share it; then it answers with what was shared", async () => {
    const known = await tracked(runtime, "github/octocat/spoon-knife", "feature", "open", "person-owner")
    const h = await open()
    const body = { owner: "octocat", name: "Spoon-Knife", ref: "feature" }
    expect(await json(await track(h, body))).toEqual([403, { code: "forbidden" }])
    await shared(runtime, known.branchId, "person-member", "view")
    expect(await json(await track(h, body))).toEqual([200, { ...known, access: "view", shared: true }])
    await shared(runtime, known.branchId, "person-member", "edit")
    expect(await json(await track(h, body))).toEqual([200, { ...known, access: "edit", shared: true }])
    // A Guest it is shared with by name opens it, to view only; one it isn't shared with doesn't.
    const guest = await open({ actor: { subject: { kind: "person", id: "person-guest" }, role: "guest" } })
    expect(await json(await track(guest, body))).toEqual([403, { code: "forbidden" }])
    await shared(runtime, known.branchId, "person-guest", "edit")
    expect(await json(await track(guest, body))).toEqual([200, { ...known, access: "view", shared: true }])
    expect(h.github.seen).toEqual([])
  })

  test("only a Member or above tracks: 401 signed out, 403 for a Guest or a person with no role", async () => {
    const body = { owner: "octocat", name: "Spoon-Knife", ref: "feature" }
    const signedOut = await branchHarness(runtime, { github: github() })
    expect(await json(await track(signedOut, body))).toEqual([401, { code: "authentication" }])
    expect(signedOut.only("branch.track").annotations).toMatchObject({ outcome: "authentication", status: 401 })
    for (const role of ["guest", null] as const) {
      const h = await open({ actor: { ...member, role } })
      expect(await json(await track(h, body))).toEqual([403, { code: "forbidden" }])
      expect(h.only("branch.track").annotations).toMatchObject({ outcome: "forbidden", status: 403 })
      expect(h.github.seen).toEqual([])
    }
    expect(await rows()).toEqual([])
  })

  test("on a repository the App is installed on, the role there decides who tracks; the deployment's never does", async () => {
    const body = { owner: "octocat", name: "Spoon-Knife", ref: "feature" }
    const sql = (statement: string) =>
      runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(statement)))
    await sql(`INSERT INTO github_repositories (repo_id, installation_id) VALUES ('github/octocat/spoon-knife', 7)`)
    try {
      /** GitHub, through `RepoRoles`, says `role` on Spoon-Knife (a test service: worker/branch/Access.test.ts is the real one). */
      const rolesThere = (role: Actor["role"] | "refused") =>
        Layer.succeed(BranchRoles, BranchRoles.of({
          roleOn: (_, repoId) =>
            role === "refused"
              ? Effect.fail(new RepoRoles.RoleRefused({ code: "github_unavailable" }))
              : Effect.succeed(repoId === "github/octocat/spoon-knife" ? role : null),
        }))
      // The deployment's Admin, a Guest there.
      const outsider = await open({ actor: { ...member, role: "admin" }, branchRoles: rolesThere("guest") })
      expect(await json(await track(outsider, body))).toEqual([403, { code: "forbidden" }])
      expect(outsider.github.seen).toEqual([])
      // GitHub not answering: 503, nothing recorded.
      const down = await open({ branchRoles: rolesThere("refused") })
      expect((await track(down, body)).status).toBe(503)
      expect(await rows()).toEqual([])
      // The deployment's Guest, a Member there: tracks it, and owns it.
      const insider = await open({ actor: { ...member, role: "guest" }, branchRoles: rolesThere("member") })
      expect((await track(insider, body)).status).toBe(201)
      expect(await rows()).toMatchObject([{ name: "feature" }])
    } finally {
      await sql(`TRUNCATE github_repositories`)
    }
  })

  test("sessions or Postgres that can't be read are 503 unavailable, logged by the failure's code", async () => {
    const sessions = await open({
      sessions: Layer.succeed(Sessions, Sessions.of({ resolve: Effect.fail(new SessionsUnavailable()) })),
    })
    expect(await json(await track(sessions, { owner: "octocat", name: "Spoon-Knife", ref: "feature" }))).toEqual([
      503,
      { code: "unavailable" },
    ])
    expect(sessions.only("branch.track")).toMatchObject({
      level: "ERROR",
      annotations: { errorCode: "@smthrs/mvp/auth/SessionsUnavailable", outcome: "unavailable", status: 503 },
    })

    const down = await open({
      database: Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers"))),
    })
    expect(await json(await track(down, { owner: "octocat", name: "Spoon-Knife", ref: "feature" }))).toEqual([
      503,
      { code: "unavailable" },
    ])
    expect(down.only("branch.track").annotations).toMatchObject({
      errorCode: expect.stringMatching(/^sql:/),
      repoId: "github/octocat/spoon-knife",
    })
  })

  test("a branch the app already tracks answers without asking GitHub", async () => {
    const known = await tracked(runtime, "github/octocat/spoon-knife", "feature")
    const h = await open()
    expect(await json(await track(h, { owner: "octocat", name: "Spoon-Knife", ref: "feature" }))).toEqual([
      200,
      { ...known, access: "edit", shared: false },
    ])
    expect(h.github.seen).toEqual([])
  })
})

/** A fresh ES256 key, as Code Storage's Keys page hands one out: a PKCS#8 PEM. */
const pem = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`
}

describe("POST /api/branches with create: a new branch", () => {
  /** The routes with Code Storage as the forge: the scripted mirror of GitHub's copy (worker/test/branch.ts). */
  const onCodeStorage = async (options: Parameters<typeof branchHarness>[1] = {}) =>
    open({ config: { CODE_STORAGE_ORG: "acme", CODE_STORAGE_KEY: await pem() }, ...options })

  const create = (h: BranchHarness, ref: string, owner = "octocat") =>
    track(h, { owner, name: "Spoon-Knife", ref, create: true })

  test("an injected Forge refusal records only its safe cause and the failed call", async () => {
    const h = await open({ forge: Forge.of({
      move: () => Effect.die("no resync"),
      pull: () => Effect.die("no resync"),
      upstream: () => Effect.succeed({ url: "https://github.com/octocat/Spoon-Knife.git" }),
      create: () => Effect.fail(new CreateRefused({
        code: "unavailable",
        errorTag: "@smthrs/effect-code-storage/CodeStorageError",
        errorCode: "insufficient_scope",
        errorStatus: 403,
      })),
    }) })
    expect(await json(await create(h, `${SENTINEL}-new`))).toEqual([503, { code: "unavailable" }])
    expect(h.only("branch.track").annotations).toMatchObject({
      forgeOperation: "create_ref",
      forgeErrorTag: "@smthrs/effect-code-storage/CodeStorageError",
      forgeErrorCode: "insufficient_scope",
      forgeStatus: 403,
    })
    expect(h.only("forge.createBranch").annotations).toMatchObject({
      forgeOperation: "create_ref",
      forgeErrorTag: "@smthrs/effect-code-storage/CodeStorageError",
      forgeErrorCode: "insufficient_scope",
      forgeStatus: 403,
    })
    for (const name of ["forge.createBranch", "branch.track"]) {
      const spans = h.span(name)
      expect(spans).toHaveLength(1)
      expect(Object.fromEntries(spans[0]!.attributes)).toMatchObject({
        forgeOperation: "create_ref",
        forgeErrorTag: "@smthrs/effect-code-storage/CodeStorageError",
        forgeErrorCode: "insufficient_scope",
        forgeStatus: 403,
      })
    }
    expect(recorded(h)).not.toContain(SENTINEL)
    expect(await rows()).toEqual([])
  })

  test.each([401, 403])("Code Storage %s refuses branch creation with no tracked row and safe cause records", async (status) => {
    const code = status === 401 ? "unauthorized" : "insufficient_scope"
    const h = await open({ forge: Forge.of({
      move: () => Effect.die("no resync"),
      pull: () => Effect.die("no resync"),
      upstream: () => Effect.succeed({ url: "https://github.com/octocat/Spoon-Knife.git" }),
      create: () => Effect.fail(new CreateRefused({
        code: "forbidden", errorTag: "@smthrs/effect-code-storage/CodeStorageError",
        errorCode: code, errorStatus: status,
      })),
    }) })
    expect(await json(await create(h, `${SENTINEL}-new`))).toEqual([403, { code: "forbidden" }])
    const cause = {
      forgeOperation: "create_ref", forgeErrorTag: "@smthrs/effect-code-storage/CodeStorageError",
      forgeErrorCode: code, forgeStatus: status,
    }
    expect(h.only("branch.track")).toMatchObject({
      level: "WARN", annotations: { ...cause, created: "forbidden", outcome: "forbidden", status: 403 },
    })
    expect(h.count(Branches.tracks, { outcome: "forbidden" })).toBe(1)
    expect(h.only("forge.createBranch").annotations).toMatchObject(cause)
    for (const name of ["forge.createBranch", "branch.track"]) {
      expect(h.span(name)).toHaveLength(1)
      expect(Object.fromEntries(h.span(name)[0]!.attributes)).toMatchObject(cause)
    }
    expect(recorded(h)).not.toContain(SENTINEL)
    expect(await rows()).toEqual([])
  })

  test("home create omits both repository names and opening refreshes the personal snapshot", async () => {
    const h = await onCodeStorage({ config: { GITHUB_REPOSITORY: "octocat/Spoon-Knife", CODE_STORAGE_ORG: "acme", CODE_STORAGE_KEY: await pem() } })
    const response = await track(h, { ref: "conversation-abcdef", create: true })
    expect(response.status).toBe(201)
    const b = await response.json() as { conversationId: string }
    const people = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT owner, repo, branch, archived_at FROM conversation_people WHERE conversation_id = ${b.conversationId}`))
    expect(people).toEqual([{ owner: "octocat", repo: "Spoon-Knife", branch: "conversation-abcdef", archived_at: null }])
    expect((await track(h, { ref: "conversation-abcdef" })).status).toBe(400)
    expect((await track(h, { owner: "octocat", ref: "conversation-abcdef", create: true })).status).toBe(400)
  })

  test("makes the branch on Code Storage at the default branch's head and records it open, the Member's; again, 200", async () => {
    const h = await onCodeStorage()
    // Observe what a device can discover at the precise point its refs cache is invalidated.
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO repositories (id, owner, name, status)
        VALUES ('github/octocat/spoon-knife', 'octocat', 'spoon-knife', 'cloning')`
      yield* sql`CREATE TABLE ref_visibility (tracked boolean NOT NULL)`
      yield* sql.unsafe(`CREATE FUNCTION record_ref_visibility() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO ref_visibility SELECT EXISTS (
            SELECT 1 FROM branches b JOIN conversations c ON c.branch_id = b.id
            WHERE b.repo_id = NEW.id AND b.name = 'maya/k3f9q2' AND b.ref_namespace = 'ephemeral'
          );
          RETURN NEW;
        END $$`)
      yield* sql`CREATE TRIGGER record_ref_visibility AFTER UPDATE OF refs_changed_at ON repositories
        FOR EACH ROW EXECUTE FUNCTION record_ref_visibility()`
    }))
    try {
      const [status, body] = await json(await create(h, "maya/k3f9q2"))
      expect(status).toBe(201)
      expect(body).toMatchObject({ name: "maya/k3f9q2", mode: "open", access: "owner", repoId: "github/octocat/spoon-knife" })
      expect(h.github.seen.filter((seen) => seen.method === "GET")).toHaveLength(1)
      expect(h.forge.created).toEqual([{ repo: "github/octocat/spoon-knife", from: "main", branch: "maya/k3f9q2" }])
      expect(h.github.repository("octocat", "Spoon-Knife")!.branches["maya/k3f9q2"]).toBeUndefined()
      expect(h.forge.ephemeral.repository("octocat", "Spoon-Knife")!.branches["maya/k3f9q2"]).toBe(shaOf("main"))
      expect(h.github.seen.every((seen) => seen.path.includes("/info/refs") || seen.path.endsWith("/git-upload-pack"))).toBe(true)
      expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        SELECT ref_namespace AS namespace FROM branches WHERE repo_id = 'github/octocat/spoon-knife' AND name = 'maya/k3f9q2'`)))
        .toEqual([{ namespace: "ephemeral" }])
      expect((await rows()).find((row) => row.name === "maya/k3f9q2")).toMatchObject({ mode: "open", baseSha: shaOf("main") })
      expect(h.only("branch.track").annotations).toMatchObject({ outcome: "tracked", created: "created", status: 201 })
      // Pressed again, or retried after a lost answer: the branch it made, at once, and nothing made twice.
      expect(await json(await create(h, "maya/k3f9q2"))).toEqual([200, body])
      expect(h.forge.created).toHaveLength(1)
      expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT tracked FROM ref_visibility`)))
        .toEqual([{ tracked: true }])
    } finally {
      await runtime.runPromise(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`DROP TRIGGER record_ref_visibility ON repositories`
        yield* sql`DROP FUNCTION record_ref_visibility()`
        yield* sql`DROP TABLE ref_visibility`
        yield* sql`DELETE FROM repositories WHERE id = 'github/octocat/spoon-knife'`
      }))
    }
  })

  test("a fresh conversation's request: its own branch again, 200; a branch the app tracks for anyone else, 409 exists", async () => {
    const h = await onCodeStorage()
    const request = "6a3c2d0e-8a8b-4c1f-9e0a-1d2b3c4d5e6f"
    const ask = (ref: string, id = request) =>
      track(h, { owner: "octocat", name: "Spoon-Knife", ref, create: true, request: id })
    const [status, body] = await json(await ask("topic"))
    expect(status).toBe(201)
    // Tried again after a lost answer: the branch it made.
    expect(await json(await ask("topic"))).toEqual([200, body])
    // Another request for the same name, or a branch the app tracked without one: someone's conversation, never fresh.
    expect(await json(await ask("topic", "0b5d7d1c-6f1d-4a65-9d7e-2c1a9c2f4b11"))).toEqual([409, { code: "exists" }])
    expect((await create(h, "plain")).status).toBe(201)
    expect(await json(await ask("plain"))).toEqual([409, { code: "exists" }])
    expect(h.forge.created.map((made) => made.branch)).toEqual(["topic", "plain"])
    // An open more than a day ahead of the server's clock can't be one.
    const ahead = await track(h, { owner: "octocat", name: "Spoon-Knife", ref: "topic", openedAt: Date.now() + 2 * 86_400_000 })
    expect(ahead.status).toBe(400)
    // A request belongs only with create.
    expect((await track(h, { owner: "octocat", name: "Spoon-Knife", ref: "topic", request })).status).toBe(400)
  })

  // A branch someone pushed under the name a create asked for was tracked as the requester's new branch, owned by them
  // and not at the default branch's head. A branch name carries no mark of who made it, so its existence is refused.
  test("an untracked ephemeral ref with no ordinary counterpart is refused by the provider and never adopted", async () => {
    const h = await onCodeStorage()
    h.forge.ephemeral.publish("octocat", "Spoon-Knife", {
      ...h.github.repository("octocat", "Spoon-Knife")!,
      branches: { "ephemeral-only": shaOf("someone-else") },
    })
    expect(await json(await create(h, "ephemeral-only"))).toEqual([409, { code: "exists" }])
    expect((await rows()).find((row) => row.name === "ephemeral-only")).toBeUndefined()
    expect(h.forge.created).toEqual([])
    expect(h.github.repository("octocat", "Spoon-Knife")!.branches["ephemeral-only"]).toBeUndefined()
    expect(h.forge.ephemeral.repository("octocat", "Spoon-Knife")!.branches["ephemeral-only"]).toBe(shaOf("someone-else"))
    expect(h.only("branch.track").annotations).toMatchObject({
      created: "exists", outcome: "exists", status: 409, forgeOperation: "create_ref",
      forgeErrorCode: "conflict", forgeStatus: 409,
    })
  })

  test("Code Storage refusing or failing: 404 for no mirror or start, 503 otherwise; nothing recorded", async () => {
    const h = await onCodeStorage()
    h.forge.fail(Response.json({ code: "repository_not_found" }, { status: 404 }))
    expect(await json(await create(h, "maya/a"))).toEqual([404, { code: "not_found" }])
    h.forge.fail(Response.json({ code: "internal_error" }, { status: 500 }))
    expect(await json(await create(h, "maya/b"))).toEqual([503, { code: "unavailable" }])
    expect(await rows()).toEqual([])
    expect(h.line("branch.track")[1]!.annotations).toMatchObject({
      forgeOperation: "create_ref", forgeErrorTag: "@smthrs/effect-code-storage/CodeStorageError",
      forgeErrorCode: "internal_error", forgeStatus: 500,
    })
    // A repository the forge doesn't have at all.
    expect(await json(await create(h, "maya/c", "nobody"))).toEqual([404, { code: "not_found" }])
  })

  test("a repository whose HEAD names no branch, or that has none, has nothing to start from: 404", async () => {
    const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`
    const advertisement = (refs: string) =>
      new Response(`${pkt("# service=git-upload-pack\n")}0000${refs}0000`, {
        headers: { "content-type": "application/x-git-upload-pack-advertisement" },
      })
    const h = await onCodeStorage()
    h.github.fail("GET", advertisement(pkt(`${shaOf("main")} HEAD\0multi_ack\n`)))
    expect(await json(await create(h, "maya/g"))).toEqual([404, { code: "not_found" }])
    h.github.fail("GET", advertisement(pkt(`${"0".repeat(40)} capabilities^{}\0multi_ack\n`)))
    expect(await json(await create(h, "maya/h"))).toEqual([404, { code: "not_found" }])
    expect(h.forge.created).toEqual([])
  })

  test("the default branch's read failing is 503 unavailable, and nothing is made", async () => {
    const h = await onCodeStorage()
    h.github.fail("GET", new Response("busy", { status: 503 }))
    expect(await json(await create(h, "maya/d"))).toEqual([503, { code: "unavailable" }])
    expect(h.forge.created).toEqual([])
    expect(h.only("branch.track").annotations).toMatchObject({
      forgeOperation: "default_branch", forgeErrorTag: "@smthrs/effect-code-storage/GitRemoteError",
      forgeErrorCode: "unavailable", forgeStatus: 503,
    })
  })

  test("the created ref read failing records refs_read without its name or response body", async () => {
    const h = await onCodeStorage()
    h.forge.ephemeral.fail("POST", new Response("credential-sentinel", { status: 502 }))
    expect(await json(await create(h, `${SENTINEL}-new`))).toEqual([503, { code: "unavailable" }])
    expect(h.only("branch.track").annotations).toMatchObject({
      forgeOperation: "refs_read", forgeErrorTag: "@smthrs/effect-code-storage/GitRemoteError",
      forgeErrorCode: "unavailable", forgeStatus: 502,
    })
    expect(recorded(h)).not.toContain(SENTINEL)
    expect(recorded(h)).not.toContain("credential-sentinel")
    expect(await rows()).toEqual([])
  })

  test("GitHub as the forge can't make a branch: 503 not_configured, and nothing is recorded", async () => {
    const h = await open()
    expect(await json(await create(h, "maya/k3f9q2"))).toEqual([503, { code: "not_configured" }])
    expect(await rows()).toEqual([])
    expect(h.only("branch.track").annotations).toMatchObject({ created: "not_configured", status: 503 })
  })

  test("only a Member or above makes one: 401 signed out, 403 for a Guest", async () => {
    const signedOut = await onCodeStorage({ actor: undefined, sessions: Layer.succeed(Sessions, Sessions.of({ resolve: Effect.succeedNone })) })
    expect((await create(signedOut, "maya/e")).status).toBe(401)
    const guest = await onCodeStorage({ actor: { subject: { kind: "person", id: "person-guest" }, role: "guest" } })
    expect(await json(await create(guest, "maya/e"))).toEqual([403, { code: "forbidden" }])
    expect(guest.forge.created).toEqual([])
  })

  test("refuses a create that isn't `true`", async () => {
    const h = await onCodeStorage()
    expect((await track(h, { owner: "octocat", name: "Spoon-Knife", ref: "maya/f", create: "yes" })).status).toBe(400)
    expect((await track(h, { owner: "octocat", name: "Spoon-Knife", ref: "maya/f", create: false })).status).toBe(400)
  })
})


test.each(["existing", "new"] as const)("tracking a %s branch deleted before its access read returns not found", async (kind) => {
  if (kind === "existing") {
    const first = await open()
    expect((await track(first, { owner: "octocat", name: "Spoon-Knife", ref: SENTINEL })).status).toBe(201)
  }
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const database = Layer.effect(SqlClient.SqlClient, Effect.map(SqlClient.SqlClient, (sql) => new Proxy(sql, {
    apply(target, receiver, args) {
      const statement = Reflect.apply(target, receiver, args)
      // Delete on the real database exactly between lookup/tracking and the permission read.
      return Array.isArray(args[0]) && args[0].join("").includes('AS "anyShare"')
        ? Effect.andThen(sql`UPDATE branches SET deleted_at = now() WHERE repo_id = 'github/octocat/spoon-knife'`, statement)
        : statement
    },
  }))).pipe(Layer.provide(scratch.database))
  const h = await open({ database })
  expect(await json(await track(h, { owner: "octocat", name: "Spoon-Knife", ref: SENTINEL }))).toEqual([404, { code: "not_found" }])
})

test("tracking refuses a repository whose HEAD has no default branch", async () => {
  const h = await open()
  const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`
  h.github.fail("GET", new Response(`${pkt("# service=git-upload-pack\n")}0000${pkt(`${shaOf("main")} HEAD\0multi_ack\n`)}0000`, {
    headers: { "content-type": "application/x-git-upload-pack-advertisement" },
  }))
  expect(await json(await track(h, { owner: "octocat", name: "Spoon-Knife", ref: SENTINEL }))).toEqual([503, { code: "unavailable" }])
  expect(await rows()).toEqual([])
})

describe("an explicit branch provider", () => {
  test("an unknown or hostile provider is invalid, and a provider without create is invalid", async () => {
    const h = await open()
    for (const provider of ["code-storage", "https://attacker.invalid", "github;token", {}, null]) {
      expect(await json(await track(h, { owner: "octocat", name: "Spoon-Knife", ref: "new", create: true, provider })))
        .toEqual([400, { code: "invalid" }])
    }
    expect(await json(await track(h, { owner: "octocat", name: "Spoon-Knife", ref: "feature", provider: "github" })))
      .toEqual([400, { code: "invalid" }])
    expect(h.forge.created).toEqual([])
    expect(await rows()).toEqual([])
  })

  test("explicit GitHub creation without a configured App fails closed and never creates a mirror ref", async () => {
    const h = await open({ config: { CODE_STORAGE_ORG: "acme", CODE_STORAGE_KEY: await pem(), GITHUB_TOKEN: "unused-global-token" } })
    expect(await json(await track(h, { owner: "octocat", name: "Spoon-Knife", ref: "new", create: true, provider: "github", request: crypto.randomUUID() })))
      .toEqual([503, { code: "not_configured" }])
    expect(h.only("branch.track").annotations).toMatchObject({ outcome: "not_configured", status: 503 })
    expect(Object.fromEntries(h.span("branch.track")[0]!.attributes)).toMatchObject({ outcome: "not_configured", "http.response.status_code": 503 })
    expect(h.count(Branches.tracks, { outcome: "not_configured" })).toBe(1)
    expect(h.count(Branches.tracks, { outcome: "unavailable" })).toBe(0)
    expect(h.forge.created).toEqual([])
    expect(h.github.repository("octocat", "Spoon-Knife")!.branches.new).toBeUndefined()
    expect(await rows()).toEqual([])
  })

  test("the default explicit request creates an ephemeral deployment ref and retains its request identity", async () => {
    const h = await open({ config: { CODE_STORAGE_ORG: "acme", CODE_STORAGE_KEY: await pem() } })
    const request = crypto.randomUUID()
    const body = { owner: "octocat", name: "Spoon-Knife", ref: "new", create: true, request }
    const [status, branch] = await json(await track(h, body))
    expect(status).toBe(201)
    expect(await json(await track(h, body))).toEqual([200, branch])
    expect(await json(await track(h, { ...body, request: crypto.randomUUID() }))).toEqual([409, { code: "exists" }])
    expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      SELECT ref_namespace AS namespace, ref_forge AS forge, create_request AS request FROM branches WHERE name = 'new'`)))
      .toEqual([{ namespace: "ephemeral", forge: "deployment", request }])
    expect(h.github.repository("octocat", "Spoon-Knife")!.branches.new).toBeUndefined()
    expect(h.forge.created).toHaveLength(1)
  })
})

test("GitHub creation admits one durable identity, returns its actual generated branch, and never launches after a terminal receipt", async () => {
  const h = await open({ config: { GITHUB_APP_ID: "17", GITHUB_APP_PRIVATE_KEY: "configured only; the durable action imports it" } })
  const request = crypto.randomUUID()
  const body = { owner: "octocat", name: "Spoon-Knife", ref: "draft", create: true, provider: "github", request }
  expect(await json(await track(h, body))).toEqual([202, { code: "requested" }])
  expect(await json(await track(h, body))).toEqual([202, { code: "requested" }])
  expect(h.starts).toEqual([
    { flow: "branch/GitHubCreate", executionId: request, payload: { request } },
    { flow: "branch/GitHubCreate", executionId: request, payload: { request } },
  ])
  expect(h.forge.created).toEqual([])
  expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    SELECT count(*)::int AS count FROM github_branch_requests WHERE id = ${request}`))).toEqual([{ count: 1 }])
  expect(await json(await track(h, { ...body, ref: "different" }))).toEqual([409, { code: "exists" }])
  const actual = "smithers/draft-123456abcdef"
  const made = await runtime.runPromise(Conversations.track("github/octocat/spoon-knife", actual, "open", shaOf("main"), member.subject.id, request, "default", "github"))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    UPDATE github_branch_requests SET branch_id = ${made.branch.branchId} WHERE id = ${request}`))
  expect(await json(await track(h, body))).toEqual([201, { ...made.branch, access: "owner", shared: false }])
  expect(h.starts).toHaveLength(2)
  expect(await runtime.runPromise(Conversations.forgeOf(made.branch.branchId))).toBe("github")
  expect(await runtime.runPromise(Conversations.namespaceOf(made.branch.branchId))).toBe("default")
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    UPDATE branches SET deleted_at = now() WHERE id = ${made.branch.branchId}`))
  expect(await json(await track(h, body))).toEqual([404, { code: "not_found" }])
  expect(h.starts).toHaveLength(2)
})

test("GitHub creation terminal provider refusals are returned without starting again", async () => {
  const h = await open({ config: { GITHUB_APP_ID: "17", GITHUB_APP_PRIVATE_KEY: "configured" } })
  for (const [failure, status] of [["forbidden", 403], ["not_found", 404], ["exists", 409], ["not_configured", 503]] as const) {
    const request = crypto.randomUUID()
    const body = { owner: "octocat", name: "Spoon-Knife", ref: `draft-${failure}`, create: true, provider: "github", request }
    expect((await track(h, body)).status).toBe(202)
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
      UPDATE github_branch_requests SET failure = ${failure} WHERE id = ${request}`))
    const starts = h.starts.length
    expect(await json(await track(h, body))).toEqual([status, { code: failure }])
    expect(h.starts).toHaveLength(starts)
  }
})

test("creation refuses an untracked ordinary ref before writing an ephemeral ref with the same app identity", async () => {
  const ordinary = github()
  ordinary.publish("octocat", "Spoon-Knife", { defaultBranch: "main", branches: { main: shaOf("main"), existing: shaOf("existing") } })
  const h = await open({ github: ordinary, config: { CODE_STORAGE_ORG: "acme", CODE_STORAGE_KEY: await pem() } })
  expect(await json(await track(h, { owner: "octocat", name: "Spoon-Knife", ref: "existing", create: true, request: crypto.randomUUID() })))
    .toEqual([409, { code: "exists" }])
  expect(h.forge.created).toEqual([])
  expect(h.forge.ephemeral.repository("octocat", "Spoon-Knife")).toBeUndefined()
  expect(await rows()).toEqual([])
  expect(h.github.repository("octocat", "Spoon-Knife")!.branches.existing).toBe(shaOf("existing"))
  expect(h.github.seen.every((seen) => seen.path.includes("/info/refs") || seen.path.endsWith("/git-upload-pack"))).toBe(true)
})

test("creation fails closed when ordinary ref collision visibility is unavailable", async () => {
  let reads = 0
  const h = await open({ forge: Forge.of({
    move: () => Effect.die("no resync"),
    pull: () => Effect.die("no resync"),
    upstream: () => Effect.succeed({ url: ++reads === 1
      ? "https://github.com/octocat/Spoon-Knife.git"
      : "https://github.com/octocat/inaccessible.git" }),
    create: () => Effect.fail(new CreateRefused({ code: "forbidden" })),
  }) })
  expect(await json(await track(h, { owner: "octocat", name: "Spoon-Knife", ref: "unreadable", create: true })))
    .toEqual([503, { code: "unavailable" }])
  expect(reads).toBe(2)
  expect(h.forge.created).toEqual([])
  expect(await rows()).toEqual([])
  expect(h.only("branch.track").annotations).toMatchObject({ outcome: "unavailable", forgeOperation: "refs_read" })
})

test("creating the repository default branch name refuses before writing an ephemeral ref or claiming its home identity", async () => {
  const h = await open({ config: { CODE_STORAGE_ORG: "acme", CODE_STORAGE_KEY: await pem() } })
  expect(await json(await track(h, { owner: "octocat", name: "Spoon-Knife", ref: "main", create: true, request: crypto.randomUUID() })))
    .toEqual([409, { code: "exists" }])
  expect(h.forge.created).toEqual([])
  expect(h.forge.ephemeral.repository("octocat", "Spoon-Knife")).toBeUndefined()
  expect(await rows()).toEqual([])
})

test("GitHub admission requires a request and a Member, and a reused identity remains private", async () => {
  const config = { GITHUB_APP_ID: "17", GITHUB_APP_PRIVATE_KEY: "configured" }
  const h = await open({ config })
  const body = { owner: "octocat", name: "Spoon-Knife", ref: "new", create: true, provider: "github" }
  expect(await json(await track(h, body))).toEqual([400, { code: "invalid" }])
  const request = crypto.randomUUID()
  expect((await track(h, { ...body, request })).status).toBe(202)
  const other = await open({ config, actor: { subject: { kind: "person", id: "other" }, role: "member" } })
  expect(await json(await track(other, { ...body, request }))).toEqual([409, { code: "exists" }])
  const guest = await open({ config, actor: { ...member, role: "guest" } })
  expect(await json(await track(guest, { ...body, request: crypto.randomUUID() }))).toEqual([403, { code: "forbidden" }])
  expect(guest.starts).toEqual([])
})

test("GitHub admission records before launch, retries the same launch identity, and refuses a host conflict", async () => {
  const config = { GITHUB_APP_ID: "17", GITHUB_APP_PRIVATE_KEY: "configured" }
  const calls: Array<unknown> = []
  let available = false
  const h = await open({ config, starter: { start: (_flow, value) => {
    calls.push(value)
    return available ? Effect.void : Effect.fail(new Flows.StartUnavailable({ errorCode: "injected" }))
  } } })
  const request = crypto.randomUUID()
  const body = { owner: "octocat", name: "Spoon-Knife", ref: "new", create: true, provider: "github", request }
  expect(await json(await track(h, body))).toEqual([503, { code: "unavailable" }])
  expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    SELECT count(*)::int AS count FROM github_branch_requests WHERE id = ${request}`))).toEqual([{ count: 1 }])
  available = true
  h.github.fail("GET", new Response("no reread of the base", { status: 500 }))
  expect(await json(await track(h, body))).toEqual([202, { code: "requested" }])
  expect(calls).toHaveLength(2)
  expect(calls[1]).toEqual(calls[0])
  const conflict = await open({ config, starter: { start: () => Effect.fail(new Flows.StartConflict({})) } })
  expect(await json(await track(conflict, { ...body, request: crypto.randomUUID() }))).toEqual([409, { code: "exists" }])
  expect(conflict.only("branch.track").annotations).toMatchObject({ outcome: "exists", status: 409 })
  expect(Object.fromEntries(conflict.span("branch.track")[0]!.attributes)).toMatchObject({ outcome: "exists", "http.response.status_code": 409 })
  expect(conflict.count(Branches.tracks, { outcome: "exists" })).toBe(1)
  expect(conflict.count(Branches.tracks, { outcome: "unavailable" })).toBe(0)
})

test("GitHub admission distinguishes an unavailable default read from a missing repository", async () => {
  const h = await open({ config: { GITHUB_APP_ID: "17", GITHUB_APP_PRIVATE_KEY: "configured" } })
  const body = { owner: "octocat", name: "Spoon-Knife", ref: "new", create: true, provider: "github", request: crypto.randomUUID() }
  h.github.fail("GET", new Response("busy", { status: 503 }))
  expect(await json(await track(h, body))).toEqual([503, { code: "unavailable" }])
  expect(await json(await track(h, { ...body, owner: "missing" }))).toEqual([404, { code: "not_found" }])
  expect(h.starts).toEqual([])
})

test("a completed GitHub branch deleted between receipt lookup and access lookup is not exposed", async () => {
  const h = await open({ config: { GITHUB_APP_ID: "17", GITHUB_APP_PRIVATE_KEY: "configured" } })
  const request = crypto.randomUUID()
  const body = { owner: "octocat", name: "Spoon-Knife", ref: "draft", create: true, provider: "github", request }
  expect((await track(h, body)).status).toBe(202)
  const made = await runtime.runPromise(Conversations.track("github/octocat/spoon-knife", "smithers/draft-123456abcdef", "open", shaOf("main"), member.subject.id, request, "default", "github"))
  await runtime.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE github_branch_requests SET branch_id = ${made.branch.branchId} WHERE id = ${request}`
    yield* sql`CREATE TABLE deletion_race_target (id uuid NOT NULL)`
    yield* sql`INSERT INTO deletion_race_target VALUES (${made.branch.branchId})`
    yield* sql`ALTER TABLE branches RENAME TO deletion_race_branches`
    yield* sql.unsafe(`CREATE FUNCTION deletion_race(branch_id uuid) RETURNS boolean LANGUAGE plpgsql AS $$
      BEGIN
        IF branch_id = (SELECT id FROM deletion_race_target) AND current_query() LIKE '%b.create_request%' THEN
          UPDATE deletion_race_branches SET deleted_at = now() WHERE id = branch_id;
        END IF;
        RETURN true;
      END $$`)
    yield* sql`CREATE VIEW branches AS SELECT * FROM deletion_race_branches b WHERE deletion_race(b.id)`
  }))
  try {
    expect(await json(await track(h, body))).toEqual([404, { code: "not_found" }])
    expect(h.starts).toHaveLength(1)
  } finally {
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`DROP VIEW branches`
      yield* sql`ALTER TABLE deletion_race_branches RENAME TO branches`
      yield* sql`DROP FUNCTION deletion_race(uuid)`
      yield* sql`DROP TABLE deletion_race_target`
    }))
  }
})
