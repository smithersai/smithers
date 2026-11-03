import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

// Guard the spec itself: running the production burst to test its load budget would recreate the incident.
// stackWrites.test.ts separately exercises the scratch reset's writes, ordering and refusal behavior.
const source = readFileSync(new URL("./fleet.spec.ts", import.meta.url), "utf8")
const setup = source.slice(source.indexOf("const runner ="), source.indexOf("const fleet ="))

test("a killed fleet spec is reset before a new runner can claim its TODOs or lanes are raised", () => {
  const reset = setup.indexOf("await cleanScratch(page, repo)")
  expect(reset, "setup must recover leftovers even when finally never ran").toBeGreaterThanOrEqual(0)
  expect(setup.indexOf("await startRunner(")).toBeGreaterThan(reset)
  expect(setup.indexOf("await configure(")).toBeGreaterThan(reset)
  expect(setup).toMatch(/await configure\(capacity, 200, "independent"\)/)
})

test("the list crosses the newest-50 boundary with the smallest burst and retains its full-count assertion", () => {
  const listing = source.slice(source.indexOf('test("fleet: lists every run:'), source.indexOf('test("fleet: stall:'))
  const quick = /index < (\d+)/.exec(listing)
  expect(quick).not.toBeNull()
  const held = [...listing.matchAll(/await running\.commit\(`(?:Oldest|Silent|Busy) /g)].length
  expect(held).toBe(3)
  const runs = held + Number(quick![1])
  expect(runs, "one oldest run must sit outside the newest 50").toBe(51)
  expect(listing).toContain(`.toHaveCount(${runs},`)
  expect(listing).toContain('toHaveAttribute("data-state", "failed"')
  expect(listing).toContain('toHaveAttribute("data-state", "working"')
  expect(listing).toContain('toHaveAttribute("data-state", "online"')
  expect(listing).toContain('.toBeLessThanOrEqual(390)')
})
