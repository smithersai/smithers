import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { initialGuide, initialSession } from "./AppState"

/*
 * The 16-lesson build (guide version 1) numbered the light lesson alone at
 * step 2; the 15-lesson build (version 2) folds it into the theme lesson, so
 * every later lesson moved one down. A persisted version-1 guide has to be
 * remapped at boot — otherwise a returning user lands one lesson ahead of
 * where they were, and the lesson they SEE (its key gesture, its button)
 * belongs to a step they are no longer on.
 */

const storageOf = (data: Map<string, string>) => ({
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => { data.set(key, value) },
  removeItem: (key: string) => { data.delete(key) },
})

const boot = async (data: Map<string, string>) =>
  createAppStore({ kind: "localStorage", storage: storageOf(data) })

for (const version of [1, 2, 3] as const) test(`legacy v${version} keeps completion history and finished stays finished`, async () => {
  for (const step of [0, 1, 5, version === 1 ? 15 : 14]) {
    const data = new Map<string, string>()
    const guide = { ...initialGuide(), version, sequence: undefined, step, completed: ["theme"], heard: "A friend" }
    data.set("smithers-mvp.app-sessions", JSON.stringify({ "s:main": { versionKey: "legacy", data: { ...initialSession("light"), draft: "keep me", guide } } }))
    const first = await boot(data)
    // Old scripts retain completion history and resume past the first-time greeting.
    const expected = step >= (version === 1 ? 15 : 14) ? 14 : 1
    expect(first.session().guide).toMatchObject({ version: 3, sequence: "practice-v4", step: expected, completed: ["theme", "tutorial.started"], heard: "A friend" })
    expect(first.session().draft).toBe("keep me")
    await first.dispose?.()
    const second = await boot(data)
    expect(second.session().guide?.step).toBe(expected)
    await second.dispose?.()
  }
})

test("a repository-v3 guide (the 10-lesson tutorial) resumes by completion signal; finished stays finished", async () => {
  for (const [step, expected] of [[3, 1], [8, 1], [9, 14]] as const) {
    const data = new Map<string, string>()
    const guide = { ...initialGuide(), sequence: "repository-v3" as const, step, completed: ["issues.opened"], declined: ["login"] as Array<"login"> }
    data.set("smithers-mvp.app-sessions", JSON.stringify({ "s:main": { versionKey: "legacy", data: { ...initialSession("light"), guide } } }))
    const store = await boot(data)
    expect(store.session().guide).toMatchObject({ sequence: "practice-v4", step: expected, completed: ["issues.opened", "tutorial.started"] })
    expect(store.session().guide?.declined).toEqual(["login"])
    await store.dispose?.()
  }
})

test("a version-3 guide is never remapped, including across a reload", async () => {
  const data = new Map<string, string>()
  const first = await boot(data)
  await first.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 5 } }).isPersisted.promise
  await first.dispose?.()
  const second = await boot(data)
  const guide = second.session().guide
  expect(guide?.version).toBe(3)
  expect(guide?.step).toBe(5)
  await second.dispose?.()
})

test("completion and a Back pause survive reloading the session", async () => {
  const data = new Map<string, string>()
  const first = await boot(data)
  await first.dispatch({ type: "guide.changed", actor: "user", guide: {
    ...initialGuide(), step: 1, completed: ["theme"], autoPaused: true,
  } }).isPersisted.promise
  await first.dispose?.()
  const second = await boot(data)
  expect(second.session().guide?.completed).toEqual(["theme"])
  expect(second.session().guide?.autoPaused).toBe(true)
  expect(second.session().guide?.step).toBe(1)
  await second.dispose?.()
})
