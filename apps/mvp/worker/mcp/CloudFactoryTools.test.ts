import { Uphill } from "@smthrs/rpc"
import { Clock, Effect, Exit, Layer, Metric, Option } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { beforeEach, describe, expect, it } from "vitest"
import * as UphillIndex from "../feeds/UphillIndex.vibe"
import type { Role } from "../Actor.vibe"
import type { Policy } from "../ops/ArtifactVisibility.ts"
import { testFile } from "../test/harness.ts"
import {
  callCloudFactoryTool,
  CLOUD_FACTORY_TOOL_DESCRIPTORS,
  CLOUD_FACTORY_TOOL_NAMES,
  isCloudFactoryTool,
  visibleDescriptors,
} from "./CloudFactoryTools.vibe"
import type { McpAuthService, McpPrincipal, McpToolContext } from "./Contract.vibe"

const runtime = testFile("cloud_factory_tools")

const readOnlyPrincipal: McpPrincipal = {
  tokenId: "tok-read",
  personId: "p-1",
  login: "alice",
  clientName: "Claude Code",
  repoScope: null,
  scopes: ["mcp:read"],
  actor: { subject: { kind: "person", id: "p-1" }, role: null, login: "alice", act: { kind: "agent", id: "mcp:tok-read" } },
}

const readWritePrincipal: McpPrincipal = {
  ...readOnlyPrincipal,
  tokenId: "tok-rw",
  scopes: ["mcp:read", "mcp:write"],
}

const POLICY: Policy = { opsRepositories: new Set(), admins: new Set() }

const PR2_REPORT = {
  execution: { trusted: false, effectiveTier: "untrusted:community", runner: "local-untrusted" },
  gate: { satisfied: false, trustTier: "untrusted:community" },
  categories: [
    { id: "correctness", title: "Correctness", score: 90, metrics: [] },
    { id: "security", title: "Security", score: 84, metrics: [] },
    { id: "performance", title: "Performance", score: 80, metrics: [] },
    { id: "reliability", title: "Reliability", score: 82, metrics: [] },
    { id: "maintainability", title: "Maintainability", score: 78, metrics: [] },
    { id: "observability", title: "Observability", score: 78, metrics: [] },
  ],
  opportunities: [],
}

const principalFor = (login: string, role: Role | null): McpPrincipal => ({
  tokenId: `tok-${login}`,
  personId: `person-${login}`,
  login,
  clientName: "MCP",
  repoScope: null,
  scopes: ["mcp:read", "mcp:write"],
  actor: { subject: { kind: "person", id: `person-${login}` }, role, login, act: { kind: "agent", id: `mcp:tok-${login}` } },
})

const authFor = (principal: McpPrincipal, role: Role | null, isPublic: boolean): McpAuthService["Service"] => ({
  authenticate: () => Effect.succeed({ _tag: "Authenticated", principal }),
  resolveRepoAccess: (_p, owner, name) =>
    Effect.succeed({ owner, name, repoId: `github/${owner}/${name}`.toLowerCase(), role, isPublic }),
  requireWriteAccess: (_p, owner, name) =>
    Effect.succeed({
      principal,
      access: { owner, name, repoId: `github/${owner}/${name}`.toLowerCase(), role, isPublic },
    }),
  listTokens: () => Effect.succeed([]),
  revokeToken: () => Effect.succeed(false),
  handleOAuthOrTokenRoute: () => Effect.succeed(Option.none()),
})

const ctxFor = (principal: McpPrincipal, owner = "smithersai", name = "smithers-ci"): McpToolContext => ({
  principal: Option.some(principal),
  defaultRepo: { owner, name },
  requestId: "req-1",
  origin: "https://smithers.sh",
})

const parseResult = (res: { readonly content: ReadonlyArray<{ readonly text: string }> }) =>
  JSON.parse(res.content[0]!.text) as Record<string, unknown>

beforeEach(() =>
  runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`TRUNCATE feed_documents, cloud_objects, repo_contributors RESTART IDENTITY`,
    ),
  ),
)

describe("CloudFactoryTools catalog and visibility", () => {
  it("registers all 15 cloud factory MCP tools covering artifacts, changesets, wiki, mythical history, audit reports, and one-time auth", () => {
    expect(CLOUD_FACTORY_TOOL_NAMES.length).toBe(15)
    expect(CLOUD_FACTORY_TOOL_DESCRIPTORS.length).toBe(15)
    for (const name of CLOUD_FACTORY_TOOL_NAMES) {
      expect(isCloudFactoryTool(name)).toBe(true)
    }
    expect(isCloudFactoryTool("pull_merge")).toBe(false)
    expect(isCloudFactoryTool("unknown_tool")).toBe(false)
  })

  it("exposes read-only tools publicly and gates write tools behind mcp:write", () => {
    const anonTools = visibleDescriptors(Option.none()).map((t) => t.name)
    expect(anonTools).toEqual([
      "artifact_list",
      "artifact_get",
      "changeset_stack_list",
      "wiki_list",
      "wiki_read",
      "mythical_history_list",
      "audit_report_list",
      "audit_report_get",
    ])

    const readTools = visibleDescriptors(Option.some(readOnlyPrincipal)).map((t) => t.name)
    expect(readTools).toEqual(anonTools)

    const rwTools = visibleDescriptors(Option.some(readWritePrincipal)).map((t) => t.name)
    expect(rwTools).toContain("artifact_put")
    expect(rwTools).toContain("changeset_create")
    expect(rwTools).toContain("wiki_write")
    expect(rwTools).toContain("mythical_history_record")
    expect(rwTools).toContain("audit_report_publish")
    expect(rwTools).toContain("auth_one_time_mint")
    expect(rwTools).toContain("pull_create")
    expect(rwTools.length).toBe(15)
  })
})

describe("audit_report_publish feed mirroring, visibility partitioning, and failure surfacing", () => {
  it("mirrors community PR 2 snapshot to uphill/untrusted-<login> + uphill-index (public) without touching canonical uphill", async () => {
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient))
    const dbLayer = Layer.succeed(SqlClient.SqlClient, sql)
    const maintainerCaller = principalFor("roninjin10", "maintainer")

    const res = await runtime.runPromise(
      callCloudFactoryTool(
        "audit_report_publish",
        { report: PR2_REPORT, commitSha: "1dd29e1c4a0f8b2d", branch: "pr-2", key: "pr2.json" },
        ctxFor(maintainerCaller),
        { database: dbLayer, policy: POLICY },
        authFor(maintainerCaller, "maintainer", true),
      ),
    )
    const body = parseResult(res)
    expect(body).toMatchObject({
      gateEligible: false,
      cacheWriteAllowed: false,
      feedMirrored: true,
      feedName: "uphill/untrusted-roninjin10",
      feedVisibility: "public",
      feedIndexName: "uphill-index",
    })

    const docs = await runtime.runPromise(
      sql<{ name: string; visibility: string; body: unknown }>`
        SELECT name, visibility, body FROM feed_documents WHERE repo = 'smithersai/smithers-ci' ORDER BY name`,
    )
    expect(docs.map((d) => [d.name, d.visibility])).toEqual([
      ["uphill-index", "public"],
      ["uphill/untrusted-roninjin10", "public"],
    ])
    const indexDoc = Uphill.decodeFeedIndex(docs[0]!.body)
    expect(indexDoc?.previews.map((p) => p.name)).toEqual(["uphill/untrusted-roninjin10"])
    const envelope = Uphill.decodeFeedBody(docs[1]!.body)
    expect(Uphill.overallScore(envelope!.report)).toBe(82)
    expect(envelope!.commit).toBe("1dd29e1c4a0f8b2d")
    expect(envelope!.provenance?.gateEligible).toBe(false)

    // Private repo untrusted publish writes ONLY uphill-index-maintainers (never public uphill-index).
    const privRes = await runtime.runPromise(
      callCloudFactoryTool(
        "audit_report_publish",
        { report: PR2_REPORT, commitSha: "1dd29e1c4a0f8b2d", key: "priv.json" },
        ctxFor(maintainerCaller, "smithersai", "private-ci"),
        { database: dbLayer, policy: POLICY },
        authFor(maintainerCaller, "maintainer", false),
      ),
    )
    expect(parseResult(privRes)).toMatchObject({
      feedMirrored: true,
      feedName: "uphill/untrusted-roninjin10",
      feedVisibility: "maintainers",
      feedIndexName: "uphill-index-maintainers",
    })
    const privDocs = await runtime.runPromise(
      sql<{ name: string; visibility: string }>`
        SELECT name, visibility FROM feed_documents WHERE repo = 'smithersai/private-ci' ORDER BY name`,
    )
    expect(privDocs).toEqual([
      { name: "uphill-index-maintainers", visibility: "maintainers" },
      { name: "uphill/untrusted-roninjin10", visibility: "maintainers" },
    ])

    // Trusted maintainer publish writes canonical `uphill` without altering community previews.
    const trustedRes = await runtime.runPromise(
      callCloudFactoryTool(
        "audit_report_publish",
        {
          report: { categories: [{ id: "correctness", title: "Correctness", score: 96, metrics: [] }] },
          commitSha: "aaaa1111",
          key: "trusted.json",
        },
        ctxFor(maintainerCaller),
        { database: dbLayer, policy: POLICY },
        authFor(maintainerCaller, "maintainer", true),
      ),
    )
    expect(parseResult(trustedRes)).toMatchObject({
      gateEligible: true,
      cacheWriteAllowed: true,
      feedMirrored: true,
      feedName: "uphill",
      feedVisibility: "public",
      feedIndexName: null,
    })
    const afterTrusted = await runtime.runPromise(
      sql<{ name: string }>`SELECT name FROM feed_documents WHERE repo = 'smithersai/smithers-ci' ORDER BY name`,
    )
    expect(afterTrusted.map((d) => d.name)).toEqual(["uphill", "uphill-index", "uphill/untrusted-roninjin10"])
  })

  it("surfaces mirror write failure with safe progress instead of ignoring it, and recovers cleanly on retry", async () => {
    const realSql = await runtime.runPromise(Effect.service(SqlClient.SqlClient))
    const faultySql = Object.assign(
      ((...args: Parameters<typeof realSql>) => realSql(...args)) as typeof realSql,
      realSql,
      {
        withTransaction: () =>
          Effect.fail(
            new SqlError.SqlError({
              reason: new SqlError.UnknownError({ cause: new Error("sensitive-db-secret-never-shown") }),
            }),
          ),
      },
    )
    const faultyLayer = Layer.succeed(SqlClient.SqlClient, faultySql)
    const healthyLayer = Layer.succeed(SqlClient.SqlClient, realSql)
    const caller = principalFor("roninjin10", "member")
    const liveClock = Effect.runSync(Clock.clockWith(Effect.succeed))
    const fixedMs = 1_764_266_400_000
    const fixedClock: Clock.Clock = {
      ...liveClock,
      monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
      sleep: (d) => liveClock.sleep(d),
      currentTimeMillisUnsafe: () => fixedMs,
      currentTimeMillis: Effect.succeed(fixedMs),
      currentTimeNanosUnsafe: () => BigInt(fixedMs) * 1_000_000n,
      currentTimeNanos: Effect.succeed(BigInt(fixedMs) * 1_000_000n),
    }

    const failedBefore = runtime.runSync(
      Metric.value(
        Metric.withAttributes(UphillIndex.auditFeedMirrors, {
          trust: "untrusted_contributor",
          visibility: "public",
          outcome: "failed",
        }),
      ),
    ).count

    const failedExit = await runtime.runPromise(
      Effect.exit(
        callCloudFactoryTool(
          "audit_report_publish",
          { report: PR2_REPORT, commitSha: "1dd29e1c4a0f8b2d", key: "retryable.json" },
          ctxFor(caller),
          { database: faultyLayer, policy: POLICY },
          authFor(caller, "member", true),
        ).pipe(Effect.provideService(Clock.Clock, fixedClock)),
      ),
    )

    expect(Exit.isFailure(failedExit)).toBe(true)
    if (Exit.isFailure(failedExit)) {
      const err = failedExit.cause.reasons[0]
      expect(err?._tag).toBe("Fail")
      const failure = (err as { readonly error: { readonly code: string; readonly message: string } }).error
      expect(failure.code).toBe("unavailable")
      expect(failure.message).toContain("Audit report stored at")
      expect(failure.message).toContain("sha256")
      expect(failure.message).toContain("mirroring to the Uphill feed failed (sql:UnknownError)")
      expect(failure.message).toContain("Retry audit_report_publish")
      expect(failure.message).not.toContain("sensitive-db-secret-never-shown")
    }

    const failedAfter = runtime.runSync(
      Metric.value(
        Metric.withAttributes(UphillIndex.auditFeedMirrors, {
          trust: "untrusted_contributor",
          visibility: "public",
          outcome: "failed",
        }),
      ),
    ).count
    expect(failedAfter).toBe(failedBefore + 1)

    // Object store write survived as safe progress while feed_documents stayed clean.
    const storedObjects = await runtime.runPromise(
      realSql<{ object_key: string }>`SELECT object_key FROM cloud_objects WHERE namespace = 'audit-report'`,
    )
    expect(storedObjects).toHaveLength(1)
    const feedRowsBeforeRetry = await runtime.runPromise(realSql`SELECT id FROM feed_documents`)
    expect(feedRowsBeforeRetry).toHaveLength(0)

    // Retrying with the healthy database succeeds and mirrors both the document and index;
    // a second identical retry at the same timestamp reports unchanged cleanly.
    const retried = await runtime.runPromise(
      callCloudFactoryTool(
        "audit_report_publish",
        { report: PR2_REPORT, commitSha: "1dd29e1c4a0f8b2d", key: "retryable.json" },
        ctxFor(caller),
        { database: healthyLayer, policy: POLICY },
        authFor(caller, "member", true),
      ).pipe(Effect.provideService(Clock.Clock, fixedClock)),
    )
    expect(parseResult(retried)).toMatchObject({
      feedMirrored: true,
      feedName: "uphill/untrusted-roninjin10",
      feedIndexName: "uphill-index",
    })

    const repeatSame = await runtime.runPromise(
      callCloudFactoryTool(
        "audit_report_publish",
        { report: PR2_REPORT, commitSha: "1dd29e1c4a0f8b2d", key: "retryable.json" },
        ctxFor(caller),
        { database: healthyLayer, policy: POLICY },
        authFor(caller, "member", true),
      ).pipe(Effect.provideService(Clock.Clock, fixedClock)),
    )
    expect(parseResult(repeatSame)).toMatchObject({ feedMirrored: true })
  })
})
