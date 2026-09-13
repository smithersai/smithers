import { expect, test } from "bun:test"
import { REEL_BUTTON, REEL_STAGES, dispatchReelDemo, scheduleReel } from "./reel.ts"

test("the reel button's single-letter key is lowercase", () => {
  expect(REEL_BUTTON.key).toMatch(/^[a-z]$/)
})

test("every capability keeps its copy and demo", () => {
  expect(REEL_STAGES.map(s => s.demo)).toEqual(["theme", "notify", "sound", "profile", "wait", "create-flow", "composer", "prototype", "revision", "plan", "review"])
  for (const stage of REEL_STAGES) {
    expect(stage.message.length).toBeGreaterThan(10)
    const calls: unknown[] = []; let sounded = false
    dispatchReelDemo(stage.demo, (...args) => { calls.push(args) }, () => { sounded = true })
    expect(calls).toEqual([["reel-demo", stage.demo]])
    expect(sounded).toBe(stage.demo === "sound")
  }
})
for (const key of ["Escape", "ArrowLeft", "ArrowRight", "x", null]) test(`reel waits for intentional input: ${key}`, () => {
  let advanced = 0, exited = 0
  const target = new EventTarget()
  const stop = scheduleReel({ target, advance: () => advanced++, exit: () => exited++ })
  expect(advanced).toBe(0)
  if (key) for (let repeat = 0; repeat < 2; repeat++) target.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key }))
  expect(advanced).toBe(key === "ArrowRight" ? 1 : 0)
  expect(exited).toBe(key === "Escape" || key === "ArrowLeft" ? 1 : 0)
  stop()
})
test("holding a shortcut and unmounted listeners cannot skip examples", () => {
  let advanced = 0
  const target = new EventTarget()
  const stop = scheduleReel({ target, advance: () => advanced++, exit: () => {} })
  target.dispatchEvent(Object.assign(new Event("keydown"), { key: "ArrowRight", repeat: true }))
  expect(advanced).toBe(0)
  stop()
  target.dispatchEvent(Object.assign(new Event("keydown"), { key: "ArrowRight" }))
  expect(advanced).toBe(0)
})
