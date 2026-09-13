import { expect, test } from "bun:test"
import { createAppStore } from "../state/AppStore"
import { initialGuide } from "../state/AppState"
import { PRACTICE_REPO, practicePicker } from "../state/practice/PracticeRepository"
import { GUIDE_STAGES } from "./lessons"

const host = () => {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
}

test("old recorded commit history stays visible while live tutorial resumes at research instead of Start", async () => {
  const storage = host()
  const first = await createAppStore({ kind: "localStorage", storage })
  await first.dispatch({ type: "card.upsert", actor: "system", card: {
    id: "practice-commits", kind: "commit-pick", title: "Commits", status: "active", createdAt: 1, ordinal: 1,
    payload: practicePicker([2, 3])
  } }).isPersisted.promise
  await first.settled?.()
  await first.dispose?.()
  const second = await createAppStore({ kind: "localStorage", storage })
  const guide = second.session().guide!
  expect(guide.step).toBe(GUIDE_STAGES.findIndex(stage => stage.kind === "do" && stage.completion === "issue.researched"))
  expect(guide.completed).toContain("tutorial.started")
  expect(guide.completed).not.toContain("commits.made")
  expect(second.collections.cards.get("practice-commits")?.payload).toMatchObject({ repo: PRACTICE_REPO, picked: [2, 3] })
  await second.dispose?.()
})

test("only a new tutorial waits at Start; reloading an explicit replay preserves its new playthrough", async () => {
  const storage = host()
  const first = await createAppStore({ kind: "localStorage", storage })
  expect((first.session().guide ?? initialGuide()).step).toBe(0)
  await first.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 0, playthrough: 1 } }).isPersisted.promise
  await first.dispatch({ type: "card.upsert", actor: "system", card: {
    id: "old-practice-commits", kind: "commit-pick", title: "Old commits", status: "active", createdAt: 1, ordinal: 1, payload: practicePicker()
  } }).isPersisted.promise
  await first.dispose?.()
  const second = await createAppStore({ kind: "localStorage", storage })
  expect(second.session().guide).toMatchObject({ step: 0, playthrough: 1, completed: [] })
  await second.dispose?.()
})
