import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { initialGuide } from "../AppState"
import { createIssuesSeam } from "./IssuesSeam"
import { createLandingsSeam } from "./LandingsSeam"
import type { SeamContext } from "./SeamContext"

async function setup(http: SeamContext["http"], local = false, select = true) {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) },
  } })
  if (local) await store.dispatch({ type: "repos.loaded", actor: "system", repos: [{ id: "play", name: "play", path: "/tmp/play", git: { branch: "main", remote: null }, warnings: [], smithers: { detected: false, workspaceFile: "", declarationFiles: [], reason: "none", workspaces: [] } }] }).isPersisted.promise
  if (!local) await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: ["will/repo", "elsewhere/repo"].map(id => ({ id, org: id.split("/")[0]!, name: "repo", ownerKind: "user" as const, head: null })) }).isPersisted.promise
  if (select) await store.dispatch({ type: "repo.selected", actor: "user", id: local ? "local:/tmp/play" : "will/repo" }).isPersisted.promise
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 3 } }).isPersisted.promise
  const ctx: SeamContext = { store, http, baseUrl: "", dispatch: store.dispatch, actor: () => "user", nextOrdinal: () => 1 }
  return { store, ctx }
}
const json = (body: unknown, status = 200) => Response.json(body, { status })
for (const kind of ["issues", "prs"] as const) {
  test(`${kind}: successful empty read persists card and completes`, async () => {
    const { ctx, store } = await setup(async () => json([]))
    const result = kind === "issues" ? await createIssuesSeam(ctx).listIssues("open") : await createLandingsSeam(ctx).listLandings()
    expect(typeof result).toBe("object")
    expect(store.collections.cards.get(`${kind}-will/repo`)).toBeDefined()
    expect(store.session().guide?.completed).toContain("issues.opened")
  })
  test(`${kind}: auth refusal never completes`, async () => {
    const { ctx, store } = await setup(async () => json({ message: "Sign in" }, 401))
    const result = kind === "issues" ? await createIssuesSeam(ctx).listIssues("open") : await createLandingsSeam(ctx).listLandings()
    expect(result).toBe("Sign in")
    expect(store.session().guide?.completed).not.toContain("issues.opened")
  })
  test(`${kind}: local-only list makes no HTTP request`, async () => {
    let calls = 0
    const { ctx, store } = await setup(async () => { calls++; return json([]) }, true)
    const result = kind === "issues" ? await createIssuesSeam(ctx).listIssues("open") : await createLandingsSeam(ctx).listLandings()
    expect(calls).toBe(0)
    expect(result).toEqual({ value: expect.stringContaining("local-only") })
    expect(store.session().guide?.completed).toContain("issues.opened")
  })
}
test("GitHub refusal beside an empty platform tracker does not complete", async () => {
  const { ctx, store } = await setup(async url => url.includes("github-repos") ? json({ message: "Sign in" }, 401) : json([]))
  await createIssuesSeam(ctx).listIssues("open")
  expect(store.session().guide?.completed).not.toContain("issues.opened")
})
for (const change of ["replay", "repo", "stage"] as const) test(`late read after ${change} does not complete`, async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const { ctx, store } = await setup(async () => { await pending; return json([]) })
  const read = createLandingsSeam(ctx).listLandings()
  if (change === "repo") await store.dispatch({ type: "repo.selected", actor: "user", id: "elsewhere/repo" }).isPersisted.promise
  else await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...store.session().guide!, ...(change === "replay" ? { playthrough: 1 } : { step: 4 }) } }).isPersisted.promise
  release(); await read
  expect(store.session().guide?.completed).not.toContain("issues.opened")
})
test("explicit unrelated repository read cannot complete", async () => {
  const { ctx, store } = await setup(async () => json([]))
  await createLandingsSeam(ctx).listLandings("elsewhere/repo")
  expect(store.session().guide?.completed).not.toContain("issues.opened")
})
test("missing repository delegates to the form controller with the original actor", async () => {
  const { ctx, store } = await setup(async () => { throw new Error("Must not fetch") }, false, false)
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [] }).isPersisted.promise
  const requests: unknown[] = []
  const seam = createIssuesSeam({ ...ctx, actor: () => "smithers" }, request => { requests.push(request); return { cardId: "form-issues.list", missing: ["repo"] } })
  expect(await seam.listIssues("closed")).toEqual({ value: "Rendered a form for repo." })
  expect(requests).toEqual([expect.objectContaining({ name: "issues.list", args: "closed", via: "agent" })])
  expect(store.session().guide?.completed).not.toContain("issues.opened")
})

test("stale GitHub fallback does not complete", async () => {
  const { ctx, store } = await setup(async url => url.includes("github-repos")
    ? Response.json([], { headers: { "x-metadata-stale": "true" } }) : json({}, 404))
  await createIssuesSeam(ctx).listIssues("open")
  expect(store.collections.cards.get("issues-will/repo")).toBeDefined()
  expect(store.session().guide?.completed).not.toContain("issues.opened")
})
test("account change while the read is pending does not complete", async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const { ctx, store } = await setup(async () => { await pending; return json([]) })
  const read = createLandingsSeam(ctx).listLandings()
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "someone-else", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  release(); await read
  expect(store.session().guide?.completed).not.toContain("issues.opened")
})
