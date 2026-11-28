// End-to-end Uphill discovery over real Postgres, real Electric, real ChatApi, real PluginsUi,
// real Uphill plugin tab (`core/feeds` + on-demand `core/feed`), and local React SSR render.
// Covers:
// 1) Existing pre-backfilled PR 2 community snapshot (score 82, commit 1dd29e1c, gate false, no baseline)
//    discovered on cold load after 0141 backfill without opening `core/feed` from RepoTab, then loaded live
//    via `core/feed` when the Uphill view subscribes and closed on leave.
// 2) Live MCP `audit_report_publish` + collector `POST /feeds` writes, visibility permissions (Member vs Maintainer),
//    canonical vs preview separation, live updates, `uphill/history` streaming, and deletion cleanup.
import { Effect, Layer, Metric, Option } from "effect"
import { SqlClient } from "effect/sql"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, test, vi } from "vitest"
import { backfillUphillFeedIndexes } from "../db/migrations/0141_uphill_feed_index.ts"
import { RepoTab } from "../plugins/uphill/src/components/RepoTab"
import { Uphill as UphillView } from "../plugins/uphill/src/components/Uphill"
import type { UphillTab } from "../plugins/uphill/src/tab"
import * as CloudFactoryTools from "../worker/mcp/CloudFactoryTools.vibe"
import type { McpAuthService, McpPrincipal } from "../worker/mcp/Contract.vibe"
import { feedsRoute } from "../src/features/feeds/contract"
import { documents as feedDocumentsMetric } from "../src/features/feeds/store.vibe"
import { member, nodeDevice, openTab, openTestApp, TEST_FEED_KEY, TestChatApi } from "../src/test/chatApi"
import { PluginsUi } from "../src/plugins/ui.vibe"

const WITHIN = 90_000
const REPO = { owner: "octo", name: "hello" } as const
const REPO_KEY = "octo/hello"

const PR2_SNAPSHOT_REPORT = {
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

const PR2_STORED_ENVELOPE = {
  report: PR2_SNAPSHOT_REPORT,
  commit: "1dd29e1c4a0f8b2d",
  branch: "pr-2",
  rules: null,
  updatedAt: "2026-11-27T18:00:00.000Z",
  provenance: {
    trust: "untrusted_contributor",
    gateEligible: false,
    cacheWriteAllowed: false,
    actor: "roninjin10",
    runner: "Community runner (roninjin10)",
  },
}

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const until = (assertion: () => void | Promise<void>) => vi.waitFor(assertion, { timeout: 60_000, interval: 25 })

const openViewer = async (role: "member" | "maintainer") => {
  const root = openTestApp({ answers: false }, { actor: { ...member, role, login: role === "maintainer" ? "maya" : "alex" } })
  runtimes.push(root)
  const api = await root.runPromise(Effect.service(TestChatApi))
  const sql = await root.runPromise(Effect.service(SqlClient.SqlClient))
  const tabRuntime = openTab(api, { host: nodeDevice({ agent: api }) })
  runtimes.push(tabRuntime)
  const plugins = await tabRuntime.runPromise(Effect.service(PluginsUi))
  const push = async (set: Record<string, unknown>) => {
    const res = await api.fetch(`${api.origin}${feedsRoute(REPO.owner, REPO.name)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_FEED_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ set }),
    })
    expect(res.status).toBe(200)
  }
  const metricCount = (outcome: "opened" | "closed") =>
    tabRuntime.runSync(Metric.value(Metric.withAttributes(feedDocumentsMetric, { outcome }))).count
  return { root, api, sql, tabRuntime, plugins, push, metricCount }
}

describe("Uphill end-to-end producer -> feed -> view", { timeout: WITHIN * 2 }, () => {
  test("cold signed-in view discovers an existing backfilled PR 2 report via uphill-index + core/feed, renders locally, and closes shapes on leave", async () => {
    const v = await openViewer("member")

    // Seed an existing pre-0141 production row at uphill/untrusted-roninjin10 (NO uphill-index yet, NO canonical uphill).
    await v.root.runPromise(
      v.sql`
        INSERT INTO feed_documents (id, repo, name, visibility, body, updated_at)
        VALUES (
          ${`${REPO_KEY}:uphill/untrusted-roninjin10`},
          ${REPO_KEY},
          'uphill/untrusted-roninjin10',
          'public',
          ${JSON.stringify(PR2_STORED_ENVELOPE)}::jsonb,
          '2026-11-27T18:00:00Z'::timestamptz
        )`,
    )
    // Run the 0141 backfill migration directly on this database.
    await v.root.runPromise(backfillUphillFeedIndexes)

    // Cold load of the Uphill plugin tab on a signed-in device.
    const tab = (await v.plugins.actions.tab("uphill")) as UphillTab

    // Header tab listens only to summary: discovers the preview via core/feeds without opening any core/feed shape!
    const stopSummary = tab.queries.summary(REPO).subscribe(() => {})
    await until(() =>
      expect(tab.queries.summary(REPO).current()).toMatchObject({
        hasFeed: true,
        overall: null,
        previewCount: 1,
      }),
    )
    expect(v.metricCount("opened")).toBe(0)
    const tabHtml = renderToStaticMarkup(createElement(RepoTab, { tab, repository: REPO }))
    expect(tabHtml).toContain("Uphill")
    expect(tabHtml).not.toContain("82")
    stopSummary()

    // Mounting the Uphill view subscribes to state -> opens real core/feed shape for uphill/untrusted-roninjin10.
    const state = tab.queries.state(REPO)
    const stopState = state.subscribe(() => {})
    await until(() => {
      const current = state.current()
      expect(current.status).toBe("ready")
      expect(current.pendingPreviews).toEqual([])
      expect(current.untrustedRuns).toHaveLength(1)
    })
    expect(v.metricCount("opened")).toBe(1)
    expect(state.current().envelope).toBeUndefined()
    expect(state.current().overall).toBeNull()
    expect(state.current().untrustedRuns[0]).toMatchObject({
      name: "uphill/untrusted-roninjin10",
      actor: "roninjin10",
      overall: 82,
      band: "warn",
    })
    expect(state.current().untrustedRuns[0]!.envelope.commit).toBe("1dd29e1c4a0f8b2d")
    expect(state.current().untrustedRuns[0]!.envelope.provenance?.gateEligible).toBe(false)

    // Local React render against the real live UphillTab confirms the user-facing output.
    const viewHtml = renderToStaticMarkup(createElement(UphillView, { tab, repository: REPO }))
    expect(viewHtml).toContain("No trusted baseline report yet")
    expect(viewHtml).toContain("Community runs (untrusted)")
    expect(viewHtml).toContain("Informational only")
    expect(viewHtml).toContain("Cache isolated")
    expect(viewHtml).toContain("@roninjin10")
    expect(viewHtml).toContain("82/100")
    expect(viewHtml).toContain("1dd29e1c")
    expect(viewHtml).toContain("Correctness")
    expect(viewHtml).toContain("Observability")
    expect(viewHtml).not.toContain("No backpressure audit published yet")

    // Leaving the Uphill view closes the on-demand core/feed Electric shape.
    stopState()
    await until(() => expect(v.metricCount("closed")).toBe(1))
  })

  test("live MCP audit_report_publish and feed pushes stream updates, enforce visibility permissions, keep baseline separate, and clean up on delete", async () => {
    // 1. Maintainer viewer sees public + maintainer previews + maintainer history live.
    const maint = await openViewer("maintainer")
    const maintTab = (await maint.plugins.actions.tab("uphill")) as UphillTab
    const maintState = maintTab.queries.state(REPO)
    const stopMaint = maintState.subscribe(() => {})
    await until(() => expect(maintState.current().status).toBe("ready"))
    expect(maintState.current().hasFeed).toBe(false)

    // Real MCP audit_report_publish writes cloud_objects + uphill/untrusted-roninjin10 + uphill-index atomically.
    const mcpCaller: McpPrincipal = {
      tokenId: "tok-mcp",
      personId: "p-roninjin10",
      login: "roninjin10",
      clientName: "MCP",
      repoScope: null,
      scopes: ["mcp:read", "mcp:write"],
      actor: { subject: { kind: "person", id: "p-roninjin10" }, role: "maintainer", login: "roninjin10", act: { kind: "agent", id: "mcp:tok-mcp" } },
    }
    const mcpAuth: McpAuthService["Service"] = {
      authenticate: () => Effect.succeed({ _tag: "Authenticated", principal: mcpCaller }),
      resolveRepoAccess: (_p, owner, name) =>
        Effect.succeed({ owner, name, repoId: `github/${owner}/${name}`.toLowerCase(), role: "maintainer", isPublic: true }),
      requireWriteAccess: (_p, owner, name) =>
        Effect.succeed({
          principal: mcpCaller,
          access: { owner, name, repoId: `github/${owner}/${name}`.toLowerCase(), role: "maintainer", isPublic: true },
        }),
      listTokens: () => Effect.succeed([]),
      revokeToken: () => Effect.succeed(false),
      handleOAuthOrTokenRoute: () => Effect.succeed(Option.none()),
    }

    const dbLayer = Layer.succeed(SqlClient.SqlClient, maint.sql)
    await maint.root.runPromise(
      CloudFactoryTools.callCloudFactoryTool(
        "audit_report_publish",
        { report: PR2_SNAPSHOT_REPORT, commitSha: "1dd29e1c4a0f8b2d", branch: "pr-2", key: "pr2.json" },
        { principal: Option.some(mcpCaller), defaultRepo: REPO, requestId: "req-live", origin: maint.api.origin },
        { database: dbLayer, policy: { opsRepositories: new Set(), admins: new Set() } },
        mcpAuth,
      ),
    )

    // Live arrival via Electric uphill-index -> core/feed -> Uphill view.
    await until(() => {
      const current = maintState.current()
      expect(current.untrustedRuns).toHaveLength(1)
      expect(current.untrustedRuns[0]).toMatchObject({ actor: "roninjin10", overall: 82 })
      expect(current.envelope).toBeUndefined()
    })

    // Collector pushes canonical baseline + maintainer-only preview + maintainer-only history.
    await maint.push({
      uphill: {
        visibility: "public",
        body: {
          commit: "base0001",
          branch: "main",
          report: { categories: [{ name: "speed", title: "Speed", score: 94, metrics: [] }], opportunities: [] },
        },
      },
      "uphill/untrusted-internal": {
        visibility: "maintainers",
        body: {
          commit: "priv9999",
          provenance: { trust: "untrusted_contributor", gateEligible: false, cacheWriteAllowed: false, actor: "internal" },
          report: { categories: [{ id: "security", title: "Security", score: 70, metrics: [] }], opportunities: [] },
        },
      },
      "uphill/history": {
        visibility: "maintainers",
        body: {
          history: [
            { commit: "h1", overall: 88, scores: { speed: 88 } },
            { commit: "h2", overall: 94, scores: { speed: 94 } },
          ],
        },
      },
    })

    await until(() => {
      const current = maintState.current()
      expect(current.overall).toBe(94)
      expect(current.history.map((h) => h.commit)).toEqual(["h1", "h2"])
      expect(current.untrustedRuns.map((r) => r.actor).sort()).toEqual(["internal", "roninjin10"])
    })

    // Live update on an already-open preview updates in place.
    await maint.push({
      "uphill/untrusted-roninjin10": {
        visibility: "public",
        body: {
          ...PR2_STORED_ENVELOPE,
          commit: "2ee39f2d00000000",
          report: { categories: [{ id: "correctness", title: "Correctness", score: 91, metrics: [] }], opportunities: [] },
        },
      },
    })
    await until(() =>
      expect(maintState.current().untrustedRuns.find((r) => r.actor === "roninjin10")?.overall).toBe(91),
    )

    // Deleting the community preview removes it from uphill-index, drops it live, and closes its Electric shape.
    const closedBeforeDelete = maint.metricCount("closed")
    await maint.push({ "uphill/untrusted-roninjin10": null })
    await until(() => {
      expect(maintState.current().untrustedRuns.map((r) => r.actor)).toEqual(["internal"])
      expect(maint.metricCount("closed")).toBeGreaterThanOrEqual(closedBeforeDelete + 1)
    })
    stopMaint()

    // 2. Non-maintainer Member viewer sees ONLY public documents, NEVER maintainer-only previews or history.
    const viewer = await openViewer("member")
    await viewer.push({
      "uphill/untrusted-roninjin10": { visibility: "public", body: PR2_STORED_ENVELOPE },
      "uphill/untrusted-secret": {
        visibility: "maintainers",
        body: {
          commit: "sec1111",
          provenance: { trust: "untrusted_contributor", gateEligible: false, cacheWriteAllowed: false, actor: "secret" },
          report: { categories: [{ id: "security", title: "Security", score: 50, metrics: [] }], opportunities: [] },
        },
      },
      "uphill/history": { visibility: "maintainers", body: { history: [{ commit: "privh1", overall: 80 }] } },
    })
    const viewerTab = (await viewer.plugins.actions.tab("uphill")) as UphillTab
    const viewerState = viewerTab.queries.state(REPO)
    const stopViewer = viewerState.subscribe(() => {})
    await until(() => {
      expect(viewerState.current().pendingPreviews).toEqual([])
      expect(viewerState.current().untrustedRuns.map((r) => r.actor)).toEqual(["roninjin10"])
    })
    expect(viewerState.current().history).toEqual([])
    expect(viewerState.current().untrustedRuns.find((r) => r.actor === "secret")).toBeUndefined()
    stopViewer()
  })
})
