import { expect,test } from "bun:test"
import { createAppStore } from "../AppStore"
import { createFilesSeam } from "./FilesSeam"
import type { SeamContext } from "./SeamContext"
import { fileOptions } from "./tutorial2-file_open"

const setup = async (answer: (url: string) => Promise<Response>) => {
  const values = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  } })
  store.dispatch({ type: "repositories.loaded", actor: "system", repositories: ["demo", "other"].map(name => ({ id: `will/${name}`, org: "will", ownerKind: "user" as const, name, head: { bookmark: "main", changeId: null, commitId: null } })) })
  store.dispatch({ type: "repo.selected", actor: "user", id: "will/demo" })
  let ordinal = 0
  const ctx: SeamContext = { store, dispatch: store.dispatch, http: answer, baseUrl: "", actor: () => "user", nextOrdinal: () => ++ordinal }
  return { store, ctx, seam: createFilesSeam(ctx) }
}
const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }))

test("chooser inventories actual nested files, excluding directories and unsafe entries", async () => {
  const { ctx } = await setup(url => json(url.endsWith("/src")
    ? [{ name: "answer.ts", type: "file" }]
    : [{ name: "src", type: "dir" }, { name: "README.md", type: "file" }, { name: "..", type: "dir" }]))
  expect(await fileOptions(ctx, "will/demo")).toEqual({ options: [
    { value: "README.md", label: "README.md" }, { value: "src/answer.ts", label: "src/answer.ts" },
  ] })
})

