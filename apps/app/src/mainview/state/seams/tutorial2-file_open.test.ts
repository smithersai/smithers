import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { initialGuide } from "../AppState"
import { GUIDE_STAGES } from "../../onboarding/lessons"
import { createFilesSeam } from "./FilesSeam"
import { fileOptions } from "./tutorial2-file_open"
import type { SeamContext } from "./SeamContext"

const fileReadLessons = ["issue.researched", "diff.file.opened"] as const
const setup = async (answer: (url: string) => Promise<Response>, completion: typeof fileReadLessons[number] = "issue.researched") => {
  const step = GUIDE_STAGES.findIndex(stage => stage.kind === "do" && stage.completion === completion)
  if (step < 0) throw new Error(`Missing lesson: ${completion}`)
  const values = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  } })
  store.dispatch({ type: "repositories.loaded", actor: "system", repositories: ["demo", "other"].map(name => ({ id: `will/${name}`, org: "will", ownerKind: "user" as const, name, head: { bookmark: "main", changeId: null, commitId: null } })) })
  store.dispatch({ type: "repo.selected", actor: "user", id: "will/demo" })
  store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step } })
  let ordinal = 0
  const ctx: SeamContext = { store, dispatch: store.dispatch, http: answer, baseUrl: "", actor: () => "user", nextOrdinal: () => ++ordinal }
  return { store, ctx, seam: createFilesSeam(ctx) }
}
const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }))

test.each([...fileReadLessons])("actual text persists in the file card without completing %s", async completion => {
  const { store, seam } = await setup(() => json({ content: "export const answer = 42\n", encoding: "utf-8" }), completion)
  await seam.readFile("answer.ts", "will/demo")
  const card = store.collections.cards.get("file-will/demo-answer.ts")
  expect(card?.kind === "file" && card.payload.content).toBe("export const answer = 42\n")
  expect(store.session().guide?.completed).not.toContain(completion)
  expect(store.session().guide?.completed).not.toContain("file.opened")
})

for (const [name, body, status] of [
  ["directory", [], 200], ["failure", { message: "denied" }, 403],
  ["malformed", {}, 200], ["binary", { content: "\u0000" }, 200],
] as const) test(`${name} does not complete`, async () => {
  const { store, seam } = await setup(() => json(body, status))
  await seam.readFile("answer.ts", "will/demo")
  expect(store.session().guide?.completed ?? []).not.toContain("file.opened")
  expect(store.session().guide?.completed ?? []).not.toContain("issue.researched")
})

test("directory listing and another repo never complete", async () => {
  const { store, seam } = await setup(url => json(url.endsWith("/contents") ? [] : { content: "real text" }))
  await seam.listFiles("/", "will/demo")
  await seam.readFile("answer.ts", "will/other")
  expect(store.session().guide?.completed ?? []).not.toContain("file.opened")
  expect(store.session().guide?.completed ?? []).not.toContain("issue.researched")
})

for (const change of ["replay", "repository", "account"] as const) test(`late read after ${change} never completes`, async () => {
  let release!: (response: Response) => void, markStarted!: () => void
  const response = new Promise<Response>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { markStarted = resolve })
  const { store, seam } = await setup(() => { markStarted(); return response })
  const pending = seam.readFile("answer.ts", "will/demo")
  // Prepared reads start after their activation boundary; race an actual in-flight read.
  await started
  if (change === "replay") await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: store.session().guide!.step, playthrough: 1 } }).isPersisted.promise
  if (change === "repository") await store.dispatch({ type: "repo.selected", actor: "user", id: "will/other" }).isPersisted.promise
  if (change === "account") await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
  release(Response.json({ content: "real text" }))
  await pending
  expect(store.session().guide?.completed ?? []).not.toContain("file.opened")
  expect(store.session().guide?.completed ?? []).not.toContain("issue.researched")
  expect([...store.collections.cards.values()].some(card => card.kind === "file" && card.payload.content === "real text")).toBe(false)
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

test.each([...fileReadLessons])("selected cloud head still reads cloud when a different local checkout is open without completing %s", async completion => {
  const { store, seam } = await setup(() => json({ content: "cloud contents" }), completion)
  store.dispatch({ type: "repos.loaded", actor: "system", repos: [localRepo] })
  store.dispatch({ type: "repo.selected", actor: "user", id: "will/demo" })
  await seam.readFile("answer.ts")
  expect(store.collections.cards.get("file-will/demo-answer.ts")?.kind).toBe("file")
  expect(store.session().guide?.completed).not.toContain(completion)
  expect(store.session().guide?.completed).not.toContain("file.opened")
})

test.each([...fileReadLessons])("local contents read also persists the exact file without completing %s", async completion => {
  const { store, seam } = await setup(() => json({ kind: "file", path: "answer.ts", size: 14, content: "local contents", truncated: false, binary: false }), completion)
  store.dispatch({ type: "repos.loaded", actor: "system", repos: [localRepo] })
  store.dispatch({ type: "repo.selected", actor: "user", id: "local:/tmp/tutorial2-file_open-demo" })
  await seam.readFile("answer.ts")
  const card = store.collections.cards.get("file-local-demo-answer.ts")
  expect(card?.kind === "file" && card.payload.content).toBe("local contents")
  expect(store.session().guide?.completed).not.toContain(completion)
  expect(store.session().guide?.completed).not.toContain("file.opened")
})
