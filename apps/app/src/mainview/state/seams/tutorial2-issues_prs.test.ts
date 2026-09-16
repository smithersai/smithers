import { expect,test } from "bun:test"
import { createAppStore } from "../AppStore"
import { PRACTICE_REPO } from "../practice/PracticeRepository"
import { createLandingsSeam } from "./LandingsSeam"
import type { SeamContext } from "./SeamContext"

async function setup(http: SeamContext["http"], local = false, select = true, _step = 1) {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) },
  } })
  if (local) await store.dispatch({ type: "repos.loaded", actor: "system", repos: [{ id: "play", name: "play", path: "/tmp/play", git: { branch: "main", remote: null }, warnings: [], smithers: { detected: false, workspaceFile: "", declarationFiles: [], reason: "none", workspaces: [] } }] }).isPersisted.promise
  if (!local) await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: ["will/repo", "elsewhere/repo"].map(id => ({ id, org: id.split("/")[0]!, name: "repo", ownerKind: "user" as const, head: null })) }).isPersisted.promise
  if (select) await store.dispatch({ type: "repo.selected", actor: "user", id: local ? "local:/tmp/play" : "will/repo" }).isPersisted.promise
  const ctx: SeamContext = { store, http, baseUrl: "", dispatch: store.dispatch, actor: () => "user", nextOrdinal: () => 1 }
  return { store, ctx }
}
const json = (body: unknown, status = 200) => Response.json(body, { status })
test("prs.view on the practice repository opens #4 with its branch, commits and patches", async () => {
  let calls = 0
  const { ctx, store } = await setup(async () => { calls++; return json([]) }, false, false, 3)
  const result = await createLandingsSeam(ctx).viewLanding(4, PRACTICE_REPO)
  expect(calls).toBe(0)
  expect(result).toEqual({ value: expect.stringContaining("#4 Add request logging by Mira Chen") })
  const card = store.collections.cards.get("practice-pr-4")
  if (card?.kind !== "pr") throw new Error("no practice pull request card")
  const payload = card.payload as typeof card.payload & {
    readonly branch?: string; readonly baseBranch?: string; readonly draft?: boolean
    readonly commits?: ReadonlyArray<{ readonly commitId?: string; readonly message: string }>
    readonly files?: ReadonlyArray<{ readonly path: string; readonly patch?: string; readonly additions?: number }>
  }
  expect(payload.branch).toBe("mira/request-logging")
  expect(payload.baseBranch).toBe("main")
  expect(payload.draft).toBe(false)
  expect(payload.commits?.[0]?.message).toBe("Add request logging")
  expect(payload.files?.[0]).toMatchObject({ path: "src/server.ts", additions: 1 })
  expect(payload.files?.[0]?.patch).toContain("console.log")
  expect(await createLandingsSeam(ctx).viewLanding(9, PRACTICE_REPO)).toBe("No pull request #9 in hello-server.")
})
