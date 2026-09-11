import { expect, test } from "bun:test"
import { REEL_STAGES, dispatchReelDemo, reelPause, scheduleReel } from "./reel.ts"
import { readPause, type GuideClock } from "./advance"

test("every removed capability is a say card with copy and an agent demo", () => {
  expect(REEL_STAGES.map(s => s.demo)).toEqual(["theme", "notify", "sound", "profile", "wait", "create-flow", "composer", "prototype", "revision", "plan", "review"])
  for (const stage of REEL_STAGES) {
    expect(stage.kind).toBe("say"); expect(stage.message.length).toBeGreaterThan(10)
    expect(reelPause(stage.message)).toBeLessThan(readPause(stage.message))
    const calls: unknown[] = []; let sounded = false
    dispatchReelDemo(stage.demo, (...args) => { calls.push(args) }, () => { sounded = true })
    expect(calls).toEqual([["reel-demo", stage.demo]])
    expect(sounded).toBe(stage.demo === "sound")
  }
})
test("pause is proportional, capped, and immediate for reduced motion", () => {
  expect(reelPause("hello there")).toBe(440)
  expect(reelPause("word ".repeat(500))).toBe(2000)
  expect(reelPause("hello", true)).toBe(0)
})
for (const key of ["Escape", "ArrowLeft", "x", null]) test(`reel clock and exit: ${key}`, () => {
  let tick = () => {}, advanced = 0, exited = 0
  const clock: GuideClock = { setTimeout: fn => { tick = fn; return 1 }, clearTimeout: () => {} }
  const target = new EventTarget()
  const stop = scheduleReel({ target, copy: "Hello", clock, advance: () => advanced++, exit: () => exited++ })
  if (key) target.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key }))
  tick(); tick()
  expect(advanced).toBe(key === "Escape" || key === "ArrowLeft" ? 0 : 1)
  expect(exited).toBe(key === "Escape" || key === "ArrowLeft" ? 1 : 0)
  stop()
})
test("unmount fences stale callbacks", () => {
  let tick = () => {}, advanced = false
  const clock: GuideClock = { setTimeout: fn => { tick = fn; return 1 }, clearTimeout: () => {} }
  const stop = scheduleReel({ target: new EventTarget(), copy: "hello", clock, advance: () => { advanced = true }, exit: () => {} })
  stop(); tick(); expect(advanced).toBe(false)
})
