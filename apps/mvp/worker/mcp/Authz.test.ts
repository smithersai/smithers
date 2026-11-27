import { digestSync } from "@smthrs/crypto"
import { Effect, Layer, Option } from "effect"
import { HttpEffect, HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import {
  MCP_BLOCKED_ACTS,
  repoMcpRoute,
  mcpAgentLabel,
  type McpScope,
} from "../../src/features/mcp/contract.ts"
import {
  PERSON_ONLY_FLOWS,
  type PersonOnlyAct,
  PROTECTED_ACTS,
  refusesPersonOnly,
  type Role,
  Sessions,
} from "../Actor.vibe"
import { repositoryOf } from "../github/Config.vibe"
import * as RepoRoles from "../github/RepoRoles.vibe"
import {
  assertNotBlockedAct,
  isBlockedMcpAct,
  makeMcpAuthService,
  timingSafeEqual,
  timingSafeEqualString,
} from "./Auth.vibe"
import * as Api from "./Api.vibe"
import { McpAuthService, McpToolError, McpToolRegistry, type McpPrincipal } from "./Contract.vibe"
import { generateMcpToken } from "./OAuth.vibe"
import { makeLiveToolDeps, makeMcpToolRegistry } from "./Tools.vibe"

const ALICE_ID = "11111111-1111-4111-8111-111111111111"
const BOB_ID = "22222222-2222-4222-8222-222222222222"
const CAROL_ID = "33333333-3333-4333-8333-333333333333"
const ADMIN_ID = "44444444-4444-4444-8444-444444444444"
const OUTSIDER_ID = "55555555-5555-4555-8555-555555555555"

const DEPLOYMENT_REPO = "github/smithersai/smithers"
const PUBLIC_REPO = "github/evmts/voltaire"
const PRIVATE_REPO = "github/acme/private-core"

interface TokenRow {
  readonly id: string
  readonly tokenSha256: string
  readonly personId: string
  readonly clientName: string
  readonly repoScope: string | null
  readonly scopes: ReadonlyArray<McpScope>
  readonly createdAtMs: number
  expiresAtMs: number
  lastUsedAtMs: number | null
  revokedAtMs: number | null
}

interface SessionReceipt {
  role: Role | null
  verifiedAtMs: number | null
}

const makeAuthzHarness = (options: {
  readonly failDb?: boolean
  readonly failTouch?: boolean
  readonly failRoleReceipt?: boolean
  readonly useRepoRolesObject?: boolean
} = {}) => {
  let nowMs = Date.UTC(2026, 10, 22, 12, 0, 0)
  let touchCount = 0
  let roleCalls = 0
  let visibilityCalls = 0

  const people = new Map<string, string>([
    [ALICE_ID, "alice"],
    [BOB_ID, "bob"],
    [CAROL_ID, "roninjin10"],
    [ADMIN_ID, "orgadmin"],
    [OUTSIDER_ID, "outsider"],
  ])
  const tokens = new Map<string, TokenRow>()
  const sessionReceipts = new Map<string, SessionReceipt>([
    [CAROL_ID, { role: "maintainer", verifiedAtMs: nowMs }],
    [ADMIN_ID, { role: "admin", verifiedAtMs: nowMs }],
  ])
  const visibility = new Map<string, boolean>([
    [DEPLOYMENT_REPO, true],
    [PUBLIC_REPO, true],
    [PRIVATE_REPO, false],
  ])
  const roleTable = new Map<string, Role | null | RepoRoles.RoleRefused>([
    [`${ALICE_ID}:${PUBLIC_REPO}`, "guest"],
    [`${ALICE_ID}:${PRIVATE_REPO}`, null],
    [`${BOB_ID}:${PUBLIC_REPO}`, "member"],
    [`${BOB_ID}:${PRIVATE_REPO}`, "member"],
    [`${CAROL_ID}:${PUBLIC_REPO}`, "maintainer"],
    [`${CAROL_ID}:${PRIVATE_REPO}`, "maintainer"],
    [`${ADMIN_ID}:${PUBLIC_REPO}`, "admin"],
    [`${ADMIN_ID}:${PRIVATE_REPO}`, "admin"],
    [`${OUTSIDER_ID}:${PUBLIC_REPO}`, null],
    [`${OUTSIDER_ID}:${PRIVATE_REPO}`, null],
  ])

  const normalize = (strings: TemplateStringsArray) =>
    strings.join(" $ ").replace(/\s+/g, " ").trim()

  const tag = <A extends object = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: ReadonlyArray<unknown>
  ): Effect.Effect<ReadonlyArray<A>, Error> =>
    Effect.try(() => {
      if (options.failDb) throw new Error("Simulated Postgres outage")
      const q = normalize(strings)

      if (q.includes("FROM one_time_auth_tokens") || q.includes("INSERT INTO repo_contributors")) return []

      if (q.includes("FROM mcp_tokens t INNER JOIN people p")) {
        const tokenSha256 = values[0] as string
        for (const t of tokens.values()) {
          if (t.tokenSha256 === tokenSha256) {
            const login = people.get(t.personId)
            if (login === undefined) return [] as ReadonlyArray<A>
            return [
              {
                id: t.id,
                tokenSha256: t.tokenSha256,
                personId: t.personId,
                login,
                clientName: t.clientName,
                repoScope: t.repoScope,
                scopes: [...t.scopes],
                revoked: t.revokedAtMs !== null,
                expired: t.expiresAtMs <= nowMs,
              },
            ] as unknown as ReadonlyArray<A>
          }
        }
        return [] as ReadonlyArray<A>
      }

      if (q.startsWith("UPDATE mcp_tokens SET last_used_at")) {
        if (options.failTouch) throw new Error("Simulated touch error")
        const tokenId = values[0] as string
        const t = tokens.get(tokenId)
        if (t !== undefined && t.revokedAtMs === null && (t.lastUsedAtMs === null || t.lastUsedAtMs < nowMs - 60_000)) {
          t.lastUsedAtMs = nowMs
          touchCount++
        }
        return [] as ReadonlyArray<A>
      }

      if (q.includes("FROM people p WHERE p.id =")) {
        const personId = values[values.length - 1] as string
        if (options.failRoleReceipt) throw new Error("Role receipt lookup failed")
        if (!people.has(personId)) return [] as ReadonlyArray<A>
        const receipt = sessionReceipts.get(personId)
        if (receipt === undefined) return [{ role: null, verifiedAt: null, nowMs: String(nowMs) }] as unknown as ReadonlyArray<A>
        return [
          {
            role: receipt.role,
            verifiedAt: receipt.verifiedAtMs === null ? null : String(receipt.verifiedAtMs),
            nowMs: String(nowMs),
          },
        ] as unknown as ReadonlyArray<A>
      }

      if (q.includes("FROM github_repositories WHERE repo_id =")) {
        const id = values[0] as string
        const pub = visibility.get(id)
        return (pub === undefined ? [] : [{ private: !pub }]) as unknown as ReadonlyArray<A>
      }

      throw new Error(`Unhandled SQL in Authz.test.ts: ${q}`)
    })

  const sqlClient = Object.assign(tag, {
    withTransaction: <A, E, R>(eff: Effect.Effect<A, E, R>) => eff,
  }) as unknown as SqlClient.SqlClient
  const database = Layer.succeed(SqlClient.SqlClient, sqlClient)

  const repoRolesObj: RepoRoles.RepoRoles = {
    repository: repositoryOf("smithersai/smithers"),
    resolve: (actor, repo) =>
      Effect.suspend(() => {
        roleCalls++
        if (repo.id === DEPLOYMENT_REPO) {
          return Effect.succeed({ role: actor.role, held: Option.none() })
        }
        const entry = roleTable.get(`${actor.subject.id}:${repo.id}`) ?? null
        if (entry instanceof RepoRoles.RoleRefused) return Effect.fail(entry)
        return Effect.succeed({ role: entry, held: Option.none() })
      }),
    publicCopy: (repo) =>
      Effect.sync(() => {
        visibilityCalls++
        return visibility.get(repo.id) ?? false
      }),
  }

  const service = Effect.runSync(
    makeMcpAuthService(
      options.useRepoRolesObject === true
        ? {
            database,
            roles: repoRolesObj,
            sessions: Sessions.of({ resolve: Effect.succeedNone }),
          }
        : {
            database,
            sessions: Sessions.of({ resolve: Effect.succeedNone }),
            resolveRole: (actor, repo) =>
              Effect.suspend(() => {
                roleCalls++
                const entry = roleTable.get(`${actor.subject.id}:${repo.id}`) ?? null
                if (entry instanceof RepoRoles.RoleRefused) return Effect.fail(entry)
                return Effect.succeed(entry)
              }),
            isRepoPublic: (repo) =>
              Effect.sync(() => {
                visibilityCalls++
                return visibility.get(repo.id) ?? false
              }),
          },
    ),
  )

  const mint = (params: {
    readonly personId: string
    readonly scopes?: ReadonlyArray<McpScope>
    readonly repoScope?: string | null
    readonly revoked?: boolean
    readonly expired?: boolean
  }) => {
    const raw = generateMcpToken()
    const id = crypto.randomUUID()
    tokens.set(id, {
      id,
      tokenSha256: digestSync(raw),
      personId: params.personId,
      clientName: "Claude Code",
      repoScope: params.repoScope ?? null,
      scopes: params.scopes ?? ["mcp:read", "mcp:write"],
      createdAtMs: nowMs,
      expiresAtMs: params.expired ? nowMs - 1_000 : nowMs + 86_400_000,
      lastUsedAtMs: null,
      revokedAtMs: params.revoked ? nowMs - 1_000 : null,
    })
    return { id, raw }
  }

  const req = (authorization?: string) =>
    HttpServerRequest.fromWeb(
      new Request("https://smithers.test/api/mcp", {
        method: "POST",
        headers: authorization === undefined ? {} : { authorization },
      }),
    )

  const authenticate = (authorization?: string, targetRepoId?: string) =>
    Effect.runPromise(service.authenticate(req(authorization), targetRepoId))

  const principalOf = async (rawToken: string): Promise<Option.Option<McpPrincipal>> => {
    const res = await authenticate(`Bearer ${rawToken}`)
    if (res._tag !== "Authenticated") throw new Error(`Expected Authenticated, got ${res._tag}`)
    return Option.some(res.principal)
  }

  return {
    service,
    database,
    people,
    tokens,
    sessionReceipts,
    visibility,
    roleTable,
    mint,
    authenticate,
    principalOf,
    getTouchCount: () => touchCount,
    getRoleCalls: () => roleCalls,
    getVisibilityCalls: () => visibilityCalls,
    advanceMs: (ms: number) => {
      nowMs += ms
    },
  }
}

describe("timingSafeEqual", () => {
  test("compares byte arrays and UTF-8 strings accurately across equal and unequal lengths", () => {
    const enc = new TextEncoder()
    expect(timingSafeEqual(enc.encode("abc"), enc.encode("abc"))).toBe(true)
    expect(timingSafeEqual(enc.encode("abc"), enc.encode("abd"))).toBe(false)
    expect(timingSafeEqual(enc.encode("abc"), enc.encode("abcd"))).toBe(false)
    expect(timingSafeEqualString("same-secret", "same-secret")).toBe(true)
    expect(timingSafeEqualString("same-secret", "diff-secret")).toBe(false)
  })
})

describe("authenticate", () => {
  test("distinguishes absent header (Anonymous) from malformed, unknown, revoked, expired, and repo-mismatched tokens", async () => {
    const h = makeAuthzHarness()

    expect(await h.authenticate()).toEqual({ _tag: "Anonymous" })

    for (const bad of [
      "",
      "Basic dXNlcjpwYXNz",
      "Bearer",
      "Bearer smm_not_mcp",
      "Bearer sma_short",
      `Bearer sma_${"z".repeat(64)}`,
      `Bearer sma_${"a".repeat(64)}, Bearer other`,
      `Bearer sma_${"b".repeat(64)}`, // unknown valid-format token
    ]) {
      expect(await h.authenticate(bad)).toEqual({ _tag: "Rejected", status: 401, code: "invalid_token" })
    }

    const revoked = h.mint({ personId: ALICE_ID, revoked: true })
    expect(await h.authenticate(`Bearer ${revoked.raw}`)).toEqual({
      _tag: "Rejected",
      status: 401,
      code: "token_revoked",
    })

    const expired = h.mint({ personId: ALICE_ID, expired: true })
    expect(await h.authenticate(`Bearer ${expired.raw}`)).toEqual({
      _tag: "Rejected",
      status: 401,
      code: "token_expired",
    })

    const pinned = h.mint({ personId: CAROL_ID, repoScope: PUBLIC_REPO })
    expect(await h.authenticate(`Bearer ${pinned.raw}`, PRIVATE_REPO)).toEqual({
      _tag: "Rejected",
      status: 403,
      code: "repo_scope_mismatch",
    })
    const matched = await h.authenticate(`Bearer ${pinned.raw}`, "github/Evmts/Voltaire")
    expect(matched._tag).toBe("Authenticated")
  })

  test("joins live people.github_login, attaches agent act, throttles last_used_at, and tolerates touch errors", async () => {
    const h = makeAuthzHarness()
    const tok = h.mint({ personId: CAROL_ID })

    const first = await h.authenticate(`Bearer ${tok.raw}`)
    expect(first._tag).toBe("Authenticated")
    if (first._tag === "Authenticated") {
      expect(first.principal.login).toBe("roninjin10")
      expect(mcpAgentLabel(first.principal.login)).toBe("roninjin10 (agent)")
      expect(first.principal.actor).toEqual({
        subject: { kind: "person", id: CAROL_ID },
        role: null,
        login: "roninjin10",
        act: { kind: "agent", id: `mcp:${tok.id}` },
      })
    }
    expect(h.getTouchCount()).toBe(1)

    // Within 60s -> last_used_at throttled (no second write)
    h.advanceMs(30_000)
    await h.authenticate(`Bearer ${tok.raw}`)
    expect(h.getTouchCount()).toBe(1)

    // After >60s + login rename -> reflects new login and updates last_used_at
    h.advanceMs(31_000)
    h.people.set(CAROL_ID, "roninjin10-renamed")
    const later = await h.authenticate(`Bearer ${tok.raw}`)
    expect(later._tag).toBe("Authenticated")
    if (later._tag === "Authenticated") {
      expect(later.principal.login).toBe("roninjin10-renamed")
    }
    expect(h.getTouchCount()).toBe(2)

    // Touch error is non-fatal
    const touchFail = makeAuthzHarness({ failTouch: true })
    const t2 = touchFail.mint({ personId: ALICE_ID })
    const res = await touchFail.authenticate(`Bearer ${t2.raw}`)
    expect(res._tag).toBe("Authenticated")
  })

  test("fails closed with 503 unavailable when database is unreachable", async () => {
    const h = makeAuthzHarness({ failDb: true })
    expect(await h.authenticate(`Bearer ${generateMcpToken()}`)).toEqual({
      _tag: "Rejected",
      status: 503,
      code: "unavailable",
    })
  })
})

describe("Person-only enforcement", () => {
  test("every MCP principal is refused by Actor.refusesPersonOnly across all PERSON_ONLY_FLOWS and PROTECTED_ACTS", async () => {
    const h = makeAuthzHarness()
    const adminTok = h.mint({ personId: ADMIN_ID, scopes: ["mcp:read", "mcp:write"] })
    const principal = Option.getOrThrow(await h.principalOf(adminTok.raw))
    const hydrated = await Effect.runPromise(
      h.service.requireWriteAccess(Option.some(principal), "evmts", "voltaire", "admin"),
    )
    expect(hydrated.principal.actor.role).toBe("admin")
    expect(hydrated.principal.actor.act).toEqual({ kind: "agent", id: `mcp:${adminTok.id}` })

    const allPersonOnlyActs: ReadonlyArray<PersonOnlyAct> = [
      ...(Object.keys(PERSON_ONLY_FLOWS) as ReadonlyArray<keyof typeof PERSON_ONLY_FLOWS>),
      ...(Object.keys(PROTECTED_ACTS) as ReadonlyArray<keyof typeof PROTECTED_ACTS>),
    ]
    for (const act of allPersonOnlyActs) {
      expect(await Effect.runPromise(refusesPersonOnly(hydrated.principal.actor, act))).toBe(true)
    }

    for (const blocked of MCP_BLOCKED_ACTS) {
      expect(isBlockedMcpAct(blocked)).toBe(true)
      expect(isBlockedMcpAct(blocked.replace("/", "_"))).toBe(true)
      const err = await Effect.runPromise(assertNotBlockedAct(blocked).pipe(Effect.result))
      expect(err._tag).toBe("Failure")
      if (err._tag === "Failure") expect(err.failure.code).toBe("person_only")
    }
  })
})

describe("Live per-repo authorization matrix & Tools.ts integration", () => {
  test("enforces anonymous, guest, member, maintainer, admin matrix on public and private repos", async () => {
    const h = makeAuthzHarness()

    // Anonymous on public vs private
    const anonPublic = await Effect.runPromise(h.service.resolveRepoAccess(Option.none(), "evmts", "voltaire"))
    expect(anonPublic).toEqual({ owner: "evmts", name: "voltaire", repoId: PUBLIC_REPO, role: null, isPublic: true })

    const anonPrivate = await Effect.runPromise(h.service.resolveRepoAccess(Option.none(), "acme", "private-core"))
    expect(anonPrivate).toEqual({ owner: "acme", name: "private-core", repoId: PRIVATE_REPO, role: null, isPublic: false })

    const anonWrite = await Effect.runPromise(
      h.service.requireWriteAccess(Option.none(), "evmts", "voltaire", "guest").pipe(Effect.result),
    )
    expect(anonWrite._tag).toBe("Failure")
    if (anonWrite._tag === "Failure") expect(anonWrite.failure.code).toBe("authentication")

    // Guest (alice): can write at guest, cannot write at member, private repo returns role: null & isPublic: false
    const aliceP = await h.principalOf(h.mint({ personId: ALICE_ID }).raw)
    const aliceGuestWrite = await Effect.runPromise(
      h.service.requireWriteAccess(aliceP, "evmts", "voltaire", "guest").pipe(Effect.result),
    )
    expect(aliceGuestWrite._tag).toBe("Success")

    const aliceMemberWrite = await Effect.runPromise(
      h.service.requireWriteAccess(aliceP, "evmts", "voltaire", "member").pipe(Effect.result),
    )
    expect(aliceMemberWrite._tag).toBe("Failure")
    if (aliceMemberWrite._tag === "Failure") expect(aliceMemberWrite.failure.code).toBe("forbidden")

    // Member (bob): can write at member, cannot write at maintainer
    const bobP = await h.principalOf(h.mint({ personId: BOB_ID }).raw)
    expect(
      (await Effect.runPromise(h.service.requireWriteAccess(bobP, "evmts", "voltaire", "member").pipe(Effect.result)))._tag,
    ).toBe("Success")
    expect(
      (await Effect.runPromise(h.service.requireWriteAccess(bobP, "evmts", "voltaire", "maintainer").pipe(Effect.result)))._tag,
    ).toBe("Failure")

    // Maintainer (roninjin10): can write at maintainer on private repo
    const carolP = await h.principalOf(h.mint({ personId: CAROL_ID }).raw)
    const carolPrivate = await Effect.runPromise(h.service.requireWriteAccess(carolP, "acme", "private-core", "maintainer"))
    expect(carolPrivate.access).toMatchObject({ role: "maintainer", isPublic: false })

    // Read-only token (`mcp:read` only) blocked on writes even for Admin
    const adminReadOnly = await h.principalOf(h.mint({ personId: ADMIN_ID, scopes: ["mcp:read"] }).raw)
    const readOnlyWrite = await Effect.runPromise(
      h.service.requireWriteAccess(adminReadOnly, "evmts", "voltaire", "guest").pipe(Effect.result),
    )
    expect(readOnlyWrite._tag).toBe("Failure")
    if (readOnlyWrite._tag === "Failure") expect(readOnlyWrite.failure.code).toBe("forbidden")
  })

  test("enforces repoScope BEFORE any role or visibility lookup (blocks cross-repo probing)", async () => {
    const h = makeAuthzHarness()
    const pinned = await h.principalOf(h.mint({ personId: ADMIN_ID, repoScope: PUBLIC_REPO }).raw)
    const res = await Effect.runPromise(
      h.service.resolveRepoAccess(pinned, "acme", "private-core").pipe(Effect.result),
    )
    expect(res._tag).toBe("Failure")
    if (res._tag === "Failure") expect(res.failure.code).toBe("forbidden")
    expect(h.getRoleCalls()).toBe(0)
    expect(h.getVisibilityCalls()).toBe(0)
  })

  test("live role demotion takes effect immediately on the next call with the same token", async () => {
    const h = makeAuthzHarness()
    const carolP = await h.principalOf(h.mint({ personId: CAROL_ID }).raw)

    expect(
      (await Effect.runPromise(h.service.requireWriteAccess(carolP, "evmts", "voltaire", "maintainer").pipe(Effect.result)))._tag,
    ).toBe("Success")

    // Demote roninjin10 from maintainer -> guest
    h.roleTable.set(`${CAROL_ID}:${PUBLIC_REPO}`, "guest")
    const afterDemote = await Effect.runPromise(
      h.service.requireWriteAccess(carolP, "evmts", "voltaire", "maintainer").pipe(Effect.result),
    )
    expect(afterDemote._tag).toBe("Failure")
    if (afterDemote._tag === "Failure") expect(afterDemote.failure.code).toBe("forbidden")

    // Remove role completely -> guest write fails too
    h.roleTable.set(`${CAROL_ID}:${PUBLIC_REPO}`, null)
    const afterRemove = await Effect.runPromise(
      h.service.requireWriteAccess(carolP, "evmts", "voltaire", "guest").pipe(Effect.result),
    )
    expect(afterRemove._tag).toBe("Failure")
  })

  test("loads fresh deployment-repo receipt when using RepoRoles and fails closed when receipt is stale", async () => {
    const h = makeAuthzHarness({ useRepoRolesObject: true })
    const carolP = await h.principalOf(h.mint({ personId: CAROL_ID }).raw)

    // Fresh receipt -> maintainer on deployment repo
    const fresh = await Effect.runPromise(h.service.resolveRepoAccess(carolP, "smithersai", "smithers"))
    expect(fresh.role).toBe("maintainer")

    // Advance past 60-minute role freshness window -> fails closed with unavailable
    h.advanceMs(61 * 60 * 1000)
    const stale = await Effect.runPromise(
      h.service.resolveRepoAccess(carolP, "smithersai", "smithers").pipe(Effect.result),
    )
    expect(stale._tag).toBe("Failure")
    if (stale._tag === "Failure") expect(stale.failure.code).toBe("unavailable")
  })

  test("maps upstream RoleRefused (rate_limited, CANT_ACT) and integrates seamlessly with Tools.ts", async () => {
    const h = makeAuthzHarness()
    const outsiderP = await h.principalOf(h.mint({ personId: OUTSIDER_ID }).raw)

    // Rate limited -> rate_limited
    h.roleTable.set(`${OUTSIDER_ID}:${PUBLIC_REPO}`, new RepoRoles.RoleRefused({ code: "rate_limited" }))
    const rateLimited = await Effect.runPromise(
      h.service.resolveRepoAccess(outsiderP, "evmts", "voltaire").pipe(Effect.result),
    )
    expect(rateLimited._tag).toBe("Failure")
    if (rateLimited._tag === "Failure") expect(rateLimited.failure.code).toBe("rate_limited")

    // CANT_ACT (app_not_installed) on public repo -> role: null, isPublic: true
    h.roleTable.set(`${OUTSIDER_ID}:${PUBLIC_REPO}`, new RepoRoles.RoleRefused({ code: "app_not_installed" }))
    const publicCantAct = await Effect.runPromise(h.service.resolveRepoAccess(outsiderP, "evmts", "voltaire"))
    expect(publicCantAct).toEqual({ owner: "evmts", name: "voltaire", repoId: PUBLIC_REPO, role: null, isPublic: true })

    // End-to-end with worker/mcp/Tools.ts: private repo hides privileged tools in listTools and denies readAccess
    const registry = await Effect.runPromise(
      makeMcpToolRegistry(
        makeLiveToolDeps({
          readTree: () => Effect.succeed({ ref: "main", paths: ["README.md"], truncated: false }),
        }),
      ).pipe(Effect.provideService(McpAuthService, h.service)),
    )

    const listed = await Effect.runPromise(registry.listTools(outsiderP, { owner: "acme", name: "private-core" }))
    expect(listed.map((t) => t.name)).not.toContain("todo_list")
    expect(listed.map((t) => t.name)).not.toContain("work_link_post")

    const privateRead = await Effect.runPromise(
      registry
        .callTool(
          "repo_tree",
          { owner: "acme", repo: "private-core" },
          { principal: outsiderP, requestId: "1", origin: "https://smithers.test" },
        )
        .pipe(Effect.result),
    )
    expect(privateRead._tag).toBe("Failure")
    if (privateRead._tag === "Failure") expect(privateRead.failure.code).toBe("forbidden")
  })
})

test("a database defect rejects authentication and a visibility outage fails closed", async () => {
  const request = HttpServerRequest.fromWeb(new Request("https://smithers.test/api/mcp", {
    headers: { authorization: "Bearer " + generateMcpToken() },
  }))
  const broken = Layer.effect(SqlClient.SqlClient, Effect.die(new Error("database defect")))
  const auth = await Effect.runPromise(makeMcpAuthService({ database: broken }))
  await expect(Effect.runPromise(auth.authenticate(request))).resolves.toEqual({
    _tag: "Rejected", status: 503, code: "unavailable",
  })

  const offline = Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("database offline")))
  const visibility = await Effect.runPromise(makeMcpAuthService({ database: offline }))
  await expect(Effect.runPromise(Effect.flip(visibility.resolveRepoAccess(Option.none(), "acme", "project"))))
    .resolves.toMatchObject({ code: "unavailable" })
})

test("an expired deployment role receipt cannot authorize an MCP principal", async () => {
  const h = makeAuthzHarness({ useRepoRolesObject: true })
  const principal = await h.principalOf(h.mint({ personId: CAROL_ID }).raw)
  h.advanceMs(86_400_000)
  await expect(Effect.runPromise(Effect.flip(h.service.resolveRepoAccess(principal, "smithersai", "smithers"))))
    .resolves.toMatchObject({ code: "unavailable" })
})

test.each([
  ["rate_limited", "rate_limited"], ["app_not_installed", "app_not_installed"], ["not_found", "not_found"],
  ["not_configured", "unavailable"], ["github_unavailable", "unavailable"], ["unavailable", "unavailable"],
] as const)("maps visibility refusal %s to %s", async (code, expected) => {
  const database = Layer.effect(SqlClient.SqlClient, Effect.die("unexpected database access"))
  const auth = await Effect.runPromise(makeMcpAuthService({
    database,
    isRepoPublic: () => Effect.fail(new RepoRoles.RoleRefused({ code, stage: "permission" })),
  }))
  await expect(Effect.runPromise(Effect.flip(auth.resolveRepoAccess(Option.none(), "acme", "project"))))
    .resolves.toMatchObject({ code: expected })
})

test("deployment role lookup distinguishes a disappeared person from a database failure", async () => {
  const removed = makeAuthzHarness({ useRepoRolesObject: true })
  const removedPrincipal = await removed.principalOf(removed.mint({ personId: CAROL_ID }).raw)
  removed.people.delete(CAROL_ID)
  await expect(Effect.runPromise(removed.service.resolveRepoAccess(removedPrincipal, "smithersai", "smithers")))
    .resolves.toMatchObject({ role: null })

  const broken = makeAuthzHarness({ useRepoRolesObject: true, failRoleReceipt: true })
  const brokenPrincipal = await broken.principalOf(broken.mint({ personId: CAROL_ID }).raw)
  await expect(Effect.runPromise(Effect.flip(broken.service.resolveRepoAccess(brokenPrincipal, "smithersai", "smithers"))))
    .resolves.toMatchObject({ code: "unavailable" })
})

test("pull_create checks current Member access and the grant before contacting GitHub", async () => {
  const h = makeAuthzHarness()
  const attempts: string[] = []
  const registry = await Effect.runPromise(makeMcpToolRegistry(makeLiveToolDeps({
    cloudFactory: {
      database: h.database,
      policy: { admins: new Set() },
      createPull: ({ login, head, draft }) => {
        attempts.push(login + " " + head)
        if (head === "orgadmin:smithers/status") {
          return Effect.succeed({ number: 17, url: "https://github.test/evmts/voltaire/pull/17", state: "open", draft })
        }
        return Effect.fail(new McpToolError({ code: "unavailable", message: "GitHub offline" }))
      },
    },
  })).pipe(Effect.provideService(McpAuthService, h.service)))
  const handle = HttpEffect.toWebHandler(Api.make().fetch.pipe(
    Effect.provideService(McpAuthService, h.service),
    Effect.provideService(McpToolRegistry, registry),
  ))
  const call = (token: string, head = "smithers/fix-status") => handle(new Request(
    "https://smithers.test" + repoMcpRoute("evmts", "voltaire"), {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "pull_create", arguments: { title: "Fix status", head, base: "stable" } } }),
    },
  ))
  const error = async (token: string, head?: string) => {
    const response = await call(token, head)
    expect(response.status).toBe(200)
    const rpc = await response.json() as { result: { isError: boolean, content: { text: string }[] } }
    expect(rpc.result.isError).toBe(true)
    return JSON.parse(rpc.result.content[0]!.text)
  }
  for (const personId of [BOB_ID, CAROL_ID, ADMIN_ID]) {
    expect(await error(h.mint({ personId }).raw)).toEqual({ code: "unavailable", message: "GitHub offline" })
  }
  const admin = h.mint({ personId: ADMIN_ID }).raw
  const opened = await call(admin, "orgadmin:smithers/status")
  expect(opened.status).toBe(200)
  const receipt = await opened.json() as { result: { content: { text: string }[] } }
  expect(JSON.parse(receipt.result.content[0]!.text)).toEqual({
    number: 17, url: "https://github.test/evmts/voltaire/pull/17", state: "open", draft: true,
    repository: "evmts/voltaire", attributedTo: "@orgadmin (agent)",
  })
  expect(await error(h.mint({ personId: ADMIN_ID, scopes: ["mcp:read"] }).raw)).toMatchObject({ code: "forbidden" })
  expect((await call(h.mint({ personId: ADMIN_ID, repoScope: PRIVATE_REPO }).raw)).status).toBe(403)
  expect(await error(admin, "bad branch")).toMatchObject({ code: "invalid_params" })
  for (const personId of [ALICE_ID, OUTSIDER_ID]) {
    expect(await error(h.mint({ personId }).raw)).toMatchObject({ code: "forbidden" })
  }
  h.roleTable.set(ADMIN_ID + ":" + PUBLIC_REPO, "guest")
  expect(await error(admin)).toMatchObject({ code: "forbidden" })
  expect((await call(h.mint({ personId: BOB_ID, revoked: true }).raw)).status).toBe(401)
  expect(attempts).toEqual(["bob smithers/fix-status", "roninjin10 smithers/fix-status", "orgadmin smithers/fix-status", "orgadmin orgadmin:smithers/status"])
})
