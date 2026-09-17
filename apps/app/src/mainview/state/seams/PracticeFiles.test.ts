import { expect, test } from "bun:test"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"
import { json, memoryStorage, silentAgent, unavailableRepositories } from "../TestFixtures"
import { PRACTICE_CARD, PRACTICE_REPO, practiceFile, practiceFilePaths } from "../practice/PracticeRepository"

const pause = () => new Promise(resolve => setTimeout(resolve, 10))
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await pause()
  expect(check()).toBe(true)
}

const setup = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repo.selected", actor: "user", id: PRACTICE_REPO }).isPersisted.promise
  const requests: string[] = []
  const controller = createAppController(store, unavailableRepositories, silentAgent, { fetchImpl: async input => {
    const url = String(input)
    requests.push(url)
    return url === "/api/public/repos" ? json(200, { repos: [] }) : json(404, {})
  } })
  return { store, controller, requests, close: () => controller.dispose() }
}

for (const door of ["slash", "agent", "form", "agent-form", "named-practice"] as const) {
  test(`the selected practice README is readable through ${door} without sign-in or HTTP`, async () => {
    const h = await setup()
    try {
      const outcome = door === "slash" ? await h.controller.commands.run("files.read", "README.md")
        : door === "agent" ? await h.controller.commands.runForAgent("files.read", "README.md")
        : await h.controller.commands.submit({ name: "files.read", actor: door === "agent-form" ? "agent" : "user",
          payload: { path: "README.md", ...(door === "named-practice" ? { repo: PRACTICE_REPO } : {}) } })
      expect(outcome.status).toBe("executed")
      const card = h.store.collections.cards.get(PRACTICE_CARD.file("README.md"))
      expect(card?.kind).toBe("file")
      expect(card?.kind === "file" ? card.payload.content : undefined).toBe(practiceFile("README.md"))
      expect(h.store.session().pendingCommand).toBeFalsy()
      expect([...h.store.collections.messages.values()].some(row => row.action?.flow === "auth.sign-in")).toBe(false)
      expect(h.requests.filter(url => url.includes("/contents") || url === "/api/public/repos")).toEqual([])
    } finally { await h.close() }
  })
}

test("the selected practice file form lists bundled paths and submits through the same source", async () => {
  const h = await setup()
  try {
    expect((await h.controller.commands.run("files.read")).status).toBe("form")
    await until(() => {
      const card = h.store.collections.cards.get("form-files.read")
      return card?.kind === "flow-form" && card.payload.fields.some(field => field.name === "path" && (field.options?.length ?? 0) > 0)
    })
    const card = h.store.collections.cards.get("form-files.read")
    const paths = card?.kind === "flow-form" ? card.payload.fields.find(field => field.name === "path")?.options?.map(option => option.value) : undefined
    expect(paths).toEqual([...practiceFilePaths()])
    await h.controller.commands.run("form.set", "form-files.read path README.md")
    await h.controller.commands.run("form.submit", "form-files.read")
    expect(h.store.collections.cards.get(PRACTICE_CARD.file("README.md"))?.status).toBe("active")
    expect(h.requests.filter(url => url.includes("/contents") || url === "/api/public/repos")).toEqual([])
  } finally { await h.close() }
})

for (const path of ["", "src", "missing", "README.md"] as const) {
  test(`practice directory ${path || "/"} stays in the bundled source`, async () => {
    const h = await setup()
    try {
      const outcome = await h.controller.commands.run("files.list", path)
      if (path === "missing" || path === "README.md") {
        expect(outcome.status).toBe("failed")
        expect(outcome.status === "failed" && outcome.error).toContain(path === "missing" ? "Path not found" : "is a file")
      } else {
        expect(outcome.status).toBe("executed")
        const card = h.store.collections.cards.get(`files-${PRACTICE_REPO}-${path || "/"}`)
        expect(card?.kind).toBe("file-list")
        const entries = card?.kind === "file-list" ? card.payload.entries : []
        expect(entries).toContainEqual({ name: path === "" ? "src" : "hello.ts", kind: path === "" ? "dir" : "file" })
      }
      expect([...h.store.collections.messages.values()].some(row => row.action?.flow === "auth.sign-in")).toBe(false)
      expect(h.requests.filter(url => url.includes("/contents") || url === "/api/public/repos")).toEqual([])
    } finally { await h.close() }
  })
}

for (const door of ["slash", "agent", "form-display"] as const) {
  test(`a selected practice source cannot authorize an explicit private target through ${door}`, async () => {
    const h = await setup()
    try {
      if (door === "slash") await h.controller.commands.run("files.read", "README.md private/secret")
      else if (door === "agent") expect((await h.controller.commands.runForAgent("files.read", "README.md private/secret")).status).toBe("failed")
      else await h.controller.commands.submit({ name: "files.read", actor: "user", payload: { path: "README.md", repo: "private/secret" }, display: `README.md ${PRACTICE_REPO}` })
      if (door !== "agent") await until(() => h.store.session().pendingCommand?.requirement === "repo-source")
      expect(h.requests.filter(url => url.includes("/contents/README.md"))).toEqual([])
      expect(h.store.collections.cards.get(PRACTICE_CARD.file("README.md"))).toBeUndefined()
    } finally { await h.close() }
  })
}

test("a pending URL keeps its target when the default practice selection is still present", async () => {
  const h = await setup()
  try {
    await h.store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "url", repo: "private/secret", phase: "pending" } }).isPersisted.promise
    expect(await h.controller.commands.run("files.read", "README.md")).toEqual({ status: "executed", value: "Requested" })
    expect(h.store.session().pendingCommand?.requirement).toBe("repository-ready")
    expect(h.store.collections.cards.get(PRACTICE_CARD.file("README.md"))).toBeUndefined()
    expect((await h.controller.commands.run("files.read", `README.md ${PRACTICE_REPO}`)).status).toBe("executed")
    expect(h.store.collections.cards.get(PRACTICE_CARD.file("README.md"))?.status).toBe("active")
  } finally { await h.close() }
})

test("selecting practice does not fall through to an unrelated open local checkout", async () => {
  const h = await setup()
  try {
    await h.store.dispatch({ type: "repos.loaded", actor: "system", repos: [{ id: "local", name: "local/checkout", path: "/home/local", warnings: [], git: { branch: "main", remote: "git@github.com:local/checkout.git" }, smithers: { detected: false, workspaceFile: null, declarationFiles: [], workspaces: [], reason: "none" } }] }).isPersisted.promise
    await h.store.dispatch({ type: "repo.selected", actor: "user", id: PRACTICE_REPO }).isPersisted.promise
    expect((await h.controller.commands.run("files.read", "README.md")).status).toBe("executed")
    expect(h.store.collections.cards.get(PRACTICE_CARD.file("README.md"))?.status).toBe("active")
    expect(h.requests.filter(url => url.includes("/contents/README.md") || url === "/api/repo/files")).toEqual([])
  } finally { await h.close() }
})
