import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage } from "../TestFixtures"
import { readRepositoryUpdate } from "./RepositoryUpdateSource"
import type { SeamContext } from "./SeamContext"

test("reads advertised pages, distinguishes PRs, scopes inbox rows, and checks closed issue updates", async () => {
  const urls: string[] = []
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const ctx: SeamContext = { store, dispatch: store.dispatch, actor: () => "user", nextOrdinal: () => 1, baseUrl: "https://example.test", http: async url => {
    urls.push(url)
    if (url.includes("github-repos")) return Response.json(new URL(url).searchParams.get("page") === "1"
      ? [{ number: 3, title: "New issue", state: "open", updated_at: "2026-09-10", labels: [{ name: "bug" }] }]
      : [{ number: 4, title: "PR update", state: "open", pull_request: {}, updated_at: "2026-09-11" }],
      new URL(url).searchParams.get("page") === "1" ? { headers: { link: '<https://untrusted.invalid/next>; rel="next"' } } : undefined)
    if (url.includes("notifications")) return Response.json([
      { id: 5, subject: { title: "Review requested", type: "PullRequest" }, repository: { full_name: "org/repo" }, unread: false, reason: "review_requested" },
      { id: 6, subject: "Other repo", repo: "other/repo", status: "unread" }
    ])
    if (url.includes("state=closed")) return Response.json([{ number: 2, title: "Closed issue", state: "closed" }])
    return Response.json([])
  } }
  const update = await readRepositoryUpdate(ctx, "org/repo")
  expect(update.issues.events.map(row => row.number)).toEqual([2, 3])
  expect(update.prs.events.map(row => row.number)).toEqual([4])
  expect(update.notifications.events).toHaveLength(1)
  expect(update.notifications.events[0]!.read).toBe(true)
  expect(urls.every(url => url.startsWith("https://example.test/"))).toBe(true)
  expect(update.issues.problems).toEqual([])
})
