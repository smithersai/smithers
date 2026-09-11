import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { initialGuide } from "../AppState"
import { createFilesSeam } from "./FilesSeam"
import { fileOptions } from "./tutorial2-file_open"
import type { SeamContext } from "./SeamContext"

const setup = async (answer: (url: string) => Promise<Response>) => {
  const values = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  } })
  store.dispatch({ type: "repositories.loaded", actor: "system", repositories: ["demo", "other"].map(name => ({ id: `will/${name}`, org: "will", ownerKind: "user" as const, name, head: { bookmark: "main", changeId: null, commitId: null } })) })
  store.dispatch({ type: "repo.selected", actor: "user", id: "will/demo" })
  store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 4 } })
  let ordinal = 0
  const ctx: SeamContext = { store, dispatch: store.dispatch, http: answer, baseUrl: "", actor: () => "user", nextOrdinal: () => ++ordinal }
  return { store, ctx, seam: createFilesSeam(ctx) }
}
const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }))

test("actual text persists in the file card and completes the current selected-repo lesson", async () => {
  const { store, seam } = await setup(() => json({ content: "export const answer = 42\n", encoding: "utf-8" }))
  await seam.readFile("answer.ts", "will/demo")
  const card = store.collections.cards.get("file-will/demo-answer.ts")
  expect(card?.kind === "file" && card.payload.content).toBe("export const answer = 42\n")
  expect(store.session().guide?.completed).toContain("file.opened")
})

for (const [name, body, status] of [
  ["directory", [], 200], ["failure", { message: "denied" }, 403],
  ["malformed", {}, 200], ["binary", { content: "\u0000" }, 200],
] as const) test(`${name} does not complete`, async () => {
  const { store, seam } = await setup(() => json(body, status))
  await seam.readFile("answer.ts", "will/demo")
  expect(store.session().guide?.completed ?? []).not.toContain("file.opened")
})

test("directory listing and another repo never complete", async () => {
  const { store, seam } = await setup(url => json(url.endsWith("/contents") ? [] : { content: "real text" }))
  await seam.listFiles("/", "will/demo")
  await seam.readFile("answer.ts", "will/other")
  expect(store.session().guide?.completed ?? []).not.toContain("file.opened")
})

for (const change of ["replay", "repository", "account"] as const) test(`late read after ${change} never completes`, async () => {
  let release!: (response: Response) => void
  const { store, seam } = await setup(() => new Promise(resolve => { release = resolve }))
  const pending = seam.readFile("answer.ts", "will/demo")
  if (change === "replay") store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 4, playthrough: 1 } })
  if (change === "repository") store.dispatch({ type: "repo.selected", actor: "user", id: "will/other" })
  if (change === "account") store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null })
  release(Response.json({ content: "real text" }))
  await pending
  expect(store.session().guide?.completed ?? []).not.toContain("file.opened")
})

test("chooser inventories actual nested files, excluding directories and unsafe entries", async () => {
  const { ctx } = await setup(url => json(url.endsWith("/src")
    ? [{ name: "answer.ts", type: "file" }]
    : [{ name: "src", type: "dir" }, { name: "README.md", type: "file" }, { name: "..", type: "dir" }]))
  expect(await fileOptions(ctx, "will/demo")).toEqual({ options: [
    { value: "README.md", label: "README.md" }, { value: "src/answer.ts", label: "src/answer.ts" },
  ] })
})

const localRepo = { id: "local-demo", name: "demo", path: "/tmp/tutorial2-file_open-demo", warnings: [], git: { branch: "main", remote: null },
  smithers: { detected: false, workspaceFile: null, declarationFiles: [], reason: "No workspace", workspaces: [] } }

test("selected cloud head still reads cloud when a different local checkout is open", async () => {
  const { store, seam } = await setup(() => json({ content: "cloud contents" }))
  store.dispatch({ type: "repos.loaded", actor: "system", repos: [localRepo] })
  store.dispatch({ type: "repo.selected", actor: "user", id: "will/demo" })
  await seam.readFile("answer.ts")
  expect(store.collections.cards.get("file-will/demo-answer.ts")?.kind).toBe("file")
  expect(store.session().guide?.completed).toContain("file.opened")
})

test("local contents read also persists the exact file and completes", async () => {
  const { store, seam } = await setup(() => json({ kind: "file", path: "answer.ts", size: 14, content: "local contents", truncated: false, binary: false }))
  store.dispatch({ type: "repos.loaded", actor: "system", repos: [localRepo] })
  store.dispatch({ type: "repo.selected", actor: "user", id: "local:/tmp/tutorial2-file_open-demo" })
  await seam.readFile("answer.ts")
  const card = store.collections.cards.get("file-local-demo-answer.ts")
  expect(card?.kind === "file" && card.payload.content).toBe("local contents")
  expect(store.session().guide?.completed).toContain("file.opened")
})
