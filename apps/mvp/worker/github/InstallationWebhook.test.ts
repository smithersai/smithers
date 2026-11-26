import { beforeEach, describe, expect, test } from "vitest"
import { GITHUB_WEBHOOK_ROUTE } from "../../src/features/issues/contract.ts"
import { testFile } from "../test/harness.ts"
import { installationChangesOf } from "./Api.vibe"
import { repositoryOf } from "./Config.vibe"
import * as Store from "./Store.ts"
import { reset, sql } from "./test/fixtures.ts"
import { delivery, githubHarness, WEBHOOK_SECRET } from "./test/harness.ts"

const WIDGETS = repositoryOf("acme/widgets")
const GADGETS = repositoryOf("acme/gadgets")
const OTHER = repositoryOf("other/private")
const referenced = (...names: ReadonlyArray<string>) => names.map((full_name) => ({ full_name }))
const installation = { id: 77 }

describe("installationChangesOf", () => {
  test("canonicalizes valid names and skips malformed entries and duplicates", () => {
    expect(installationChangesOf("installation", {
      action: "created",
      installation,
      repositories: [...referenced("Acme/Widgets", "acme/widgets", "acme/widgets/extra", "-bad/name", "acme/..", "alone"), null, { full_name: 42 }],
    })).toEqual({ installationId: 77, added: [WIDGETS.id], removed: [] })
  })

  test("an installation delivery without a repository list changes no links", () => {
    expect(installationChangesOf("installation", { action: "created", installation }))
      .toEqual({ installationId: 77, added: [], removed: [] })
    expect(installationChangesOf("installation_repositories", { action: "added", installation }))
      .toEqual({ installationId: 77, added: [], removed: [] })
    expect(installationChangesOf("installation_repositories", { action: "removed", installation }))
      .toEqual({ installationId: 77, added: [], removed: [] })
  })

  test("ignores unknown actions, other events, and invalid installation ids", () => {
    expect(installationChangesOf("installation", { action: "unsuspend", installation })).toBeUndefined()
    expect(installationChangesOf("installation_repositories", { action: "unknown", installation })).toBeUndefined()
    expect(installationChangesOf("ping", { action: "created", installation })).toBeUndefined()
    for (const id of [undefined, null, "77", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(installationChangesOf("installation", { action: "created", installation: { id } })).toBeUndefined()
    }
  })
})

describe("installation webhooks", () => {
  const runtime = testFile("github_installation_webhook")
  beforeEach(() => reset(runtime))

  const rows = () => sql(runtime, `SELECT repo_id, installation_id::int, private FROM github_repositories ORDER BY repo_id`)

  test("creation immediately overrides the cached About absence", async () => {
    await sql(runtime, `INSERT INTO repo_about (repo_id, app_absent_until) VALUES ('${GADGETS.id}', now() + interval '1 hour')`)
    const h = await githubHarness(runtime)
    expect(await runtime.runPromise(Store.appAbsent(GADGETS.id))).toBe(true)
    expect(await h.maySync(GADGETS)).toBe(false)

    const id = crypto.randomUUID()
    const sent = await delivery("installation", { action: "created", installation, repositories: referenced("Acme/Gadgets") }, { id })
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, sent)).status).toBe(200)
    expect(await rows()).toEqual([{ repo_id: GADGETS.id, installation_id: 77, private: null }])
    expect(await runtime.runPromise(Store.appAbsent(GADGETS.id))).toBe(false)
    expect(await h.maySync(GADGETS)).toBe(true)
    expect(await sql(runtime, `SELECT delivery_id, event, action FROM github_deliveries`)).toEqual([
      { delivery_id: id, event: "installation", action: "created" },
    ])
    const log = h.line("github.webhook")[0]
    expect(log?.annotations).toMatchObject({ installed: 1, uninstalled: 0, outcome: "applied" })
    expect(JSON.stringify(log)).not.toContain(GADGETS.id)
    expect(JSON.stringify(log)).not.toContain(WEBHOOK_SECRET)
    expect(h.spans.find((span) => span.name === "github.webhook")?.attributes.get("installed")).toBe(1)
    expect(h.starts).toEqual([])
  })

  test("added and removed update only the named repositories and redelivery cannot restore a removed link", async () => {
    const h = await githubHarness(runtime)
    await sql(runtime, `INSERT INTO github_repositories (repo_id, private) VALUES ('${WIDGETS.id}', true)`)
    const added = await delivery("installation_repositories", {
      action: "added", installation, repositories_added: referenced("acme/widgets", "acme/gadgets"),
    })
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, added)).status).toBe(200)
    expect(await rows()).toEqual([
      { repo_id: GADGETS.id, installation_id: 77, private: null },
      { repo_id: WIDGETS.id, installation_id: 77, private: true },
    ])
    const removed = await delivery("installation_repositories", {
      action: "removed", installation, repositories_removed: referenced("acme/widgets"),
    })
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, removed)).status).toBe(200)
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, added)).status).toBe(200)
    const staleRemoval = await delivery("installation_repositories", {
      action: "removed", installation: { id: 88 }, repositories_removed: referenced("acme/gadgets"),
    })
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, staleRemoval)).status).toBe(200)
    expect(await rows()).toEqual([
      { repo_id: GADGETS.id, installation_id: 77, private: null },
      { repo_id: WIDGETS.id, installation_id: null, private: true },
    ])
    expect(h.line("github.webhook").map((line) => line.annotations)).toMatchObject([
      { installed: 2, uninstalled: 0, outcome: "applied" },
      { installed: 0, uninstalled: 1, outcome: "applied" },
      { installed: 0, uninstalled: 0, outcome: "duplicate" },
      { installed: 0, uninstalled: 0, outcome: "ignored" },
    ])
  })

  test("a failed update rolls back all links and leaves the delivery retryable", async () => {
    const h = await githubHarness(runtime)
    const sent = await delivery("installation", {
      action: "created", installation, repositories: referenced("acme/gadgets", "acme/widgets"),
    })
    await sql(runtime, `ALTER TABLE github_repositories ADD CONSTRAINT reject_widgets CHECK (repo_id <> '${WIDGETS.id}')`)
    try {
      expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, sent)).status).toBe(503)
      expect(await rows()).toEqual([])
      expect(await sql(runtime, `SELECT delivery_id FROM github_deliveries`)).toEqual([])
    } finally {
      await sql(runtime, `ALTER TABLE github_repositories DROP CONSTRAINT reject_widgets`)
    }
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, sent)).status).toBe(200)
    expect(await rows()).toEqual([
      { repo_id: GADGETS.id, installation_id: 77, private: null },
      { repo_id: WIDGETS.id, installation_id: 77, private: null },
    ])
  })

  test("the allowlist blocks both additions and removals outside the deployment", async () => {
    const h = await githubHarness(runtime, { allowed: new Set([GADGETS.id]) })
    const repositories = referenced("acme/gadgets", "other/private")
    const added = await delivery("installation", { action: "created", installation, repositories })
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, added)).status).toBe(200)
    expect(await rows()).toEqual([{ repo_id: GADGETS.id, installation_id: 77, private: null }])

    await runtime.runPromise(Store.rememberInstallation(OTHER.id, installation.id))
    const removed = await delivery("installation_repositories", { action: "removed", installation, repositories_removed: repositories })
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, removed)).status).toBe(200)
    expect(await rows()).toEqual([
      { repo_id: GADGETS.id, installation_id: null, private: null },
      { repo_id: OTHER.id, installation_id: 77, private: null },
    ])
  })

  test.each(["deleted", "suspend"])("%s forgets linked repositories when GitHub omits the list", async (action) => {
    const h = await githubHarness(runtime, { allowed: new Set([GADGETS.id]) })
    await runtime.runPromise(Store.rememberInstallation(GADGETS.id, installation.id))
    await runtime.runPromise(Store.rememberInstallation(OTHER.id, installation.id))
    await runtime.runPromise(Store.rememberInstallation(WIDGETS.id, 88))
    const sent = await delivery("installation", { action, installation })
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, sent)).status).toBe(200)
    expect(await rows()).toEqual([
      { repo_id: GADGETS.id, installation_id: null, private: null },
      { repo_id: WIDGETS.id, installation_id: 88, private: null },
      { repo_id: OTHER.id, installation_id: 77, private: null },
    ])
  })

  test("malformed deliveries are harmless and an invalid signature cannot write a link", async () => {
    const h = await githubHarness(runtime)
    for (const payload of [
      null,
      { action: "created", installation: {}, repositories: referenced("acme/widgets") },
      { action: "created", installation, repositories: referenced("acme/widgets/extra", "-bad/widgets", "acme/") },
      { action: "created", installation, repositories: { full_name: "acme/widgets" } },
    ]) {
      const response = await h.fetch(GITHUB_WEBHOOK_ROUTE, await delivery("installation", payload))
      expect(response.status).toBe(200)
    }
    const forged = await delivery("installation", { action: "created", installation, repositories: referenced("acme/widgets") }, { secret: "wrong" })
    expect((await h.fetch(GITHUB_WEBHOOK_ROUTE, forged)).status).toBe(401)
    expect(await rows()).toEqual([])
  })
})
