import { expect, test } from "bun:test"
import { flowRequirements } from "../../flows/registry"
import type { CommandState } from "../../flows/registry"
import { createAppController } from "../AppController"
import { createAppStore } from "../AppStore"
import { json, memoryStorage, silentAgent, unavailableRepositories } from "../TestFixtures"
import { PRACTICE_CARD, PRACTICE_REPO, PRACTICE_RUN_ID, practiceCommitsSource } from "../practice/PracticeRepository"
import { commitCardId, commitListCardId } from "./CommitsSeam"

const pause = () => new Promise(resolve => setTimeout(resolve, 10))
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await pause()
  expect(check()).toBe(true)
}

const listed = practiceCommitsSource.list()
if (typeof listed === "string") throw new Error(listed)
const COMMIT = listed.commits[0]!.changeId!

const setup = async (selected: string | null = PRACTICE_REPO) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
  if (selected !== null && selected !== PRACTICE_REPO) {
    const [org = "", name = ""] = selected.split("/")
    await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [{ id: selected, org, name, ownerKind: "user", head: null }] }).isPersisted.promise
  }
  if (selected !== null) await store.dispatch({ type: "repo.selected", actor: "user", id: selected }).isPersisted.promise
  const requests: string[] = []
  const controller = createAppController(store, unavailableRepositories, silentAgent, { fetchImpl: async input => {
    const url = String(input)
    requests.push(url)
    return url === "/api/public/repos" ? json(200, { repos: [] }) : json(404, {})
  } })
  /* The hosted read routes these flows use; the selection's own factory probe is not one of them. */
  const reads = () => requests.filter(url =>
    /\/api\/repos\/.+\/(issues|pulls|changes|commits|bookmarks)(\/|\?|$)/.test(url) ||
    url.includes("/api/repo/files") || url === "/api/public/repos")
  const prompts = () => [...store.collections.messages.values()].filter(row => row.action?.flow === "auth.sign-in")
  return { store, controller, requests, reads, prompts, close: () => controller.dispose() }
}

/** Every repository-scoped read the practice bundle answers, with the card each one publishes. */
const READS = [
  { flow: "commits.list", args: "", payload: {}, card: commitListCardId(PRACTICE_REPO, listed.branch), kind: "commit-list" },
  { flow: "commits.read", args: COMMIT, payload: { ref: COMMIT }, card: commitCardId(PRACTICE_REPO, COMMIT), kind: "commit" },
  { flow: "issues.view", args: "3", payload: { number: 3 }, card: PRACTICE_CARD.issue(3), kind: "issue" },
  { flow: "prs.view", args: "4", payload: { number: 4 }, card: "practice-pr-4", kind: "pr" }
] as const

for (const door of ["slash", "agent", "form", "explicit"] as const) {
  for (const read of READS) {
    test(`${read.flow} answers from the selected practice repository through ${door}`, async () => {
      const h = await setup()
      try {
        const outcome = door === "slash" ? await h.controller.commands.run(read.flow, read.args)
          : door === "agent" ? await h.controller.commands.runForAgent(read.flow, read.args)
          : door === "form" ? await h.controller.commands.submit({ name: read.flow, actor: "user", payload: read.payload })
          : await h.controller.commands.run(read.flow, `${read.args} ${PRACTICE_REPO}`.trim())
        expect(outcome.status).toBe("executed")
        const card = h.store.collections.cards.get(read.card)
        expect(card?.kind).toBe(read.kind)
        expect(card?.status).toBe("active")
        expect(h.store.session().pendingCommand).toBeFalsy()
        expect(h.prompts()).toEqual([])
        expect(h.reads()).toEqual([])
      } finally { await h.close() }
    })
  }
}

for (const flow of ["issues.close", "issues.comment"] as const) {
  test(`${flow} edits the selected practice issue in the bundle, without sign-in or HTTP`, async () => {
    const h = await setup()
    try {
      const outcome = await h.controller.commands.run(flow, flow === "issues.close" ? "3" : "3 Looks right to me")
      expect(outcome.status).toBe("executed")
      await until(() => h.store.collections.practiceIssues.get("0:3") !== undefined)
      const saved = h.store.collections.practiceIssues.get("0:3")?.card
      const payload = saved?.kind === "issue" ? saved.payload : undefined
      if (flow === "issues.close") expect(payload?.state).toBe("closed")
      else expect(payload?.comments.at(-1)?.commentBody).toBe("Looks right to me")
      expect(h.store.session().pendingCommand).toBeFalsy()
      expect(h.prompts()).toEqual([])
      expect(h.reads()).toEqual([])
    } finally { await h.close() }
  })
}

test("repo-read admits the resolved practice source and nothing else", () => {
  const row = flowRequirements.find(candidate => candidate.id === "repo-read")
  expect(row?.fulfill).toBe("auth.prompt")
  const state: CommandState = { surface: "chat", typing: false, hasConnectors: false, admin: false, signedOut: true }
  expect(row!.satisfied(state)).toBe(false)
  expect(row!.satisfied({ ...state, practiceRepo: true })).toBe(true)
  expect(row!.satisfied({ ...state, hasOpenRepos: true })).toBe(false)
  expect(row!.satisfied({ ...state, publicRepo: true })).toBe(false)
  expect(row!.satisfied({ ...state, signedOut: false })).toBe(true)
})

/* Negative control 1: a selected PRIVATE repository keeps the sign-in gate. */
for (const door of ["slash", "agent"] as const) {
  test(`a selected private repository still gates every practice-capable read through ${door}`, async () => {
    const h = await setup("private/secret")
    try {
      for (const read of READS) {
        if (door === "agent") expect((await h.controller.commands.runForAgent(read.flow, read.args)).status).toBe("failed")
        else {
          expect((await h.controller.commands.run(read.flow, read.args)).status).toBe("executed")
          await until(() => h.store.session().pendingCommand?.requirement === "repo-read")
        }
        expect(h.store.collections.cards.get(read.card)).toBeUndefined()
      }
      expect(h.prompts().length).toBe(READS.length)
      expect(h.reads()).toEqual([])
    } finally { await h.close() }
  })
}

/* Negative control 2: a recorded run is decided by its run id, never by the selection. */
test("a recorded run under a selected practice repository is decided by its run id, never by the selection", async () => {
  const h = await setup()
  try {
    expect((await h.controller.commands.run("runs.logs", "run-from-the-cloud")).status).toBe("executed")
    await until(() => h.store.session().pendingCommand?.requirement === "signed-in")
    expect([...h.store.collections.cards.values()].some(card => card.kind === "run-trace")).toBe(false)
    await h.controller.commands.run("runs.logs", PRACTICE_RUN_ID)
    // The practice run id is admitted on its own; the cloud run stays parked on sign-in.
    expect(h.store.session().pendingCommand).toMatchObject({ args: "run-from-the-cloud", requirement: "signed-in" })
    expect(h.prompts().length).toBe(1)
  } finally { await h.close() }
})

/* Negative control 3: an explicit non-practice target under a practice selection still gates. */
for (const door of ["slash", "agent", "form-display"] as const) {
  test(`an explicit private target under the practice selection still gates through ${door}`, async () => {
    const h = await setup()
    try {
      if (door === "slash") await h.controller.commands.run("issues.view", "3 private/secret")
      else if (door === "agent") expect((await h.controller.commands.runForAgent("issues.view", "3 private/secret")).status).toBe("failed")
      else await h.controller.commands.submit({ name: "issues.view", actor: "user", payload: { number: 3, repo: "private/secret" }, display: `3 ${PRACTICE_REPO}` })
      if (door !== "agent") await until(() => h.store.session().pendingCommand?.requirement === "repo-read")
      expect(h.store.collections.cards.get(PRACTICE_CARD.issue(3))).toBeUndefined()
      expect(h.reads()).toEqual([])
    } finally { await h.close() }
  })
}

/* Negative control 4: an open local checkout is never the authority for a hosted read. */
test("the practice selection answers from the bundle beside an open local checkout, which authorizes nothing on its own", async () => {
  const local = { id: "local", name: "local/checkout", path: "/home/local", warnings: [], git: { branch: "main", remote: "git@github.com:local/checkout.git" }, smithers: { detected: false, workspaceFile: null, declarationFiles: [], workspaces: [], reason: "none" as const } }
  const h = await setup()
  try {
    await h.store.dispatch({ type: "repos.loaded", actor: "system", repos: [local] }).isPersisted.promise
    await h.store.dispatch({ type: "repo.selected", actor: "user", id: PRACTICE_REPO }).isPersisted.promise
    expect((await h.controller.commands.run("issues.view", "3")).status).toBe("executed")
    expect(h.store.collections.cards.get(PRACTICE_CARD.issue(3))?.status).toBe("active")
    expect(h.reads()).toEqual([])
  } finally { await h.close() }
  const bare = await setup(null)
  try {
    await bare.store.dispatch({ type: "repos.loaded", actor: "system", repos: [local] }).isPersisted.promise
    expect((await bare.controller.commands.run("issues.view", "3")).status).toBe("executed")
    await until(() => bare.store.session().pendingCommand?.requirement === "repo-read")
    expect(bare.store.collections.cards.get(PRACTICE_CARD.issue(3))).toBeUndefined()
    expect(bare.reads()).toEqual([])
  } finally { await bare.close() }
})

/* Negative control 5: a pending repository URL keeps its target; practice never hijacks it. */
test("a pending repository URL keeps its target while the practice selection is still present", async () => {
  const h = await setup()
  try {
    await h.store.dispatch({ type: "repository.entry.changed", actor: "system", entry: { requestId: "url", repo: "private/secret", phase: "pending" } }).isPersisted.promise
    expect((await h.controller.commands.run("issues.view", "3")).status).toBe("executed")
    await until(() => h.store.session().pendingCommand?.requirement === "repo-read")
    expect(h.store.collections.cards.get(PRACTICE_CARD.issue(3))).toBeUndefined()
    expect(h.reads()).toEqual([])
    expect((await h.controller.commands.run("issues.view", `3 ${PRACTICE_REPO}`)).status).toBe("executed")
    expect(h.store.collections.cards.get(PRACTICE_CARD.issue(3))?.status).toBe("active")
  } finally { await h.close() }
})
