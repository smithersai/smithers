import { expect, test } from "bun:test"
import { GUIDE_LESSONS, GUIDE_STAGES } from "./lessons"
import { readPause, scheduleGuideAdvance, type GuideClock } from "./advance"
import { guideActionState } from "./actionState"
import { initialGuide } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import { memoryStorage } from "../state/TestFixtures"
import { createGuideController } from "../state/controller/guide"
import type { ControllerContext } from "../state/controller/context"

for (const step of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
  test(`the completed beat ${step} pill advances after Back without replaying its operation`, async () => {
    const lesson = GUIDE_STAGES[step]!
    if (lesson.kind !== "do") throw Error("expected action lesson")
    const completed = GUIDE_STAGES.slice(0, step + 1).flatMap(stage => stage.kind === "do" ? [stage.completion] : [])
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: step + 1, completed } }).isPersisted.promise
    const controller = createGuideController({ store, commandActor: "user" } as ControllerContext)
    await controller.guideAct("back")
    const guide = store.session().guide!
    expect(guide).toMatchObject({ step, autoPaused: true, completed })
    const pill = guideActionState(lesson.actions[0]!, [], guide)
    expect(pill).toMatchObject({ key: lesson.actions[0]!.key, flow: "onboarding.act", args: "next" })
    expect(pill.disabled).not.toBe(true)
    await controller.guideAct(pill.args!)
    expect(store.session().guide).toMatchObject({ step: step + 1, autoPaused: false, completed })
    await store.dispose?.()
  })
}

test("every stage declares its kind and every action its completion signal", () => {
  expect(GUIDE_STAGES.map(stage => stage.kind === "do" ? stage.completion : "say")).toEqual([
    "tutorial.started", "issues.opened", "issue.opened", "issue.flows.opened", "issue.researched", "plan.ready", "commits.made",
    "diff.opened", "diff.file.opened", "change.opened", "identity.signed-in", "github.app.installed",
    "librarian.runs.launched", "palette.opened", "say",
  ])
  expect(GUIDE_STAGES).toHaveLength(GUIDE_LESSONS.length)
  for (const stage of GUIDE_STAGES) {
    expect(["say", "do"]).toContain(stage.kind)
    if (stage.kind === "do") expect(stage.completion.length).toBeGreaterThan(0)
  }
})
const setup = (paused = false, reduced = false) => {
  let callback = () => {}
  let advanced = 0, cancelled = 0, delay = -1
  const clock: GuideClock = {
    setTimeout: (fn, ms) => { callback = fn; delay = ms; return 1 },
    clearTimeout: () => { callback = () => {} },
  }
  const target = new EventTarget()
  const dispose = scheduleGuideAdvance({ target, clock, delay: readPause("Hello there", reduced),
    paused, advance: () => advanced++, cancel: () => cancelled++ })
  return { target, dispose, tick: () => callback(), state: () => ({ advanced, cancelled, delay }) }
}
test("read pause advances once, proportional to copy and capped", () => {
  const timer = setup()
  expect(timer.state().delay).toBe(650)
  expect(timer.state().advanced).toBe(0)
  timer.tick(); timer.tick()
  expect(timer.state().advanced).toBe(1)
  expect(readPause("word ".repeat(500))).toBe(3000)
  timer.dispose()
})
for (const event of ["click", "pointerdown", "keydown", "input"]) test(event + " cancels advancement", () => {
  const timer = setup()
  timer.target.dispatchEvent(new Event(event))
  timer.tick()
  expect(timer.state()).toMatchObject({ advanced: 0, cancelled: 1 })
  timer.dispose()
})
test("Back pauses advancement and unmount cancels it", () => {
  const paused = setup(true)
  paused.tick()
  expect(paused.state().advanced).toBe(0)
  const mounted = setup()
  mounted.dispose(); mounted.tick()
  expect(mounted.state().advanced).toBe(0)
})
test("reduced motion schedules immediately", () => {
  const timer = setup(false, true)
  expect(timer.state().delay).toBe(0)
  timer.tick()
  expect(timer.state().advanced).toBe(1)
  timer.dispose()
})

test("login waits for identity, not a navigation key", () => {
  expect(GUIDE_STAGES[10]).toMatchObject({ kind: "do", completion: "identity.signed-in", skippable: false })
})
