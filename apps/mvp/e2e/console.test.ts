import { describe, expect, it } from "vitest"
import { chromium } from "@playwright/test"
import { consoleLine, recordConsole, wholeLine, wholeText } from "./console"

// The browser log's lines (e2e/console.ts): Chrome's preview, which `text()` returns, keeps an object's first five
// properties; the line written from the values keeps them all.

/** What `text()` gave for the engine worker's `sandbox.call` on smithers.sh, 2026-10-25, and what was logged. */
const preview = "[16:06:23.847] INFO (#8556): sandbox.call {runId: r1, stepKey: k1, attempt: 8, tier: sealed, tool: write}"
const logged = [
  "[16:06:23.847] INFO (#8556): sandbox.call",
  { runId: "r1", stepKey: "k1", attempt: 8, tier: "sealed", tool: "write", outcome: "done", callId: "c1", feature: "sandbox" },
]

describe("wholeLine", () => {
  it("writes out every field of an object argument the preview cut at five", () => {
    expect(wholeLine(preview, logged)).toBe(
      "[16:06:23.847] INFO (#8556): sandbox.call " +
        `{"runId":"r1","stepKey":"k1","attempt":8,"tier":"sealed","tool":"write","outcome":"done","callId":"c1","feature":"sandbox"}`,
    )
  })

  it("keeps text() where it is already whole: strings, numbers, booleans, null or nothing", () => {
    expect(wholeLine("ready 3 true null", ["ready", 3, true, null])).toBe("ready 3 true null")
    expect(wholeLine("", [])).toBe("")
  })

  it("keeps text() where the first argument formats the rest", () => {
    for (const format of ["%s", "%d", "%i", "%f", "%o", "%O", "%c"]) {
      expect(wholeLine("formatted", [`${format}[16:06] INFO`, { a: 1 }])).toBe("formatted")
    }
  })

  it("keeps text() when the values couldn't be read", () => {
    expect(wholeLine(preview, undefined)).toBe(preview)
  })

  it("writes arrays and nested objects as JSON, and a value JSON has no notation for as itself", () => {
    expect(wholeLine("x", ["rows", [1, { b: [2] }], undefined])).toBe(`rows [1,{"b":[2]}] undefined`)
  })
})

describe("consoleLine", () => {
  it("joins strings as themselves and everything else as JSON", () => {
    expect(consoleLine(["a", 1, false, null, { k: "v" }])).toBe(`a 1 false null {"k":"v"}`)
  })
})

// Read actual Chromium handles: Playwright can deserialize values that JSON.stringify cannot represent.
it("keeps browser previews for nested BigInt and cyclic objects without breaking later diagnostics", async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const log: string[] = []
    recordConsole(page, log)
    for (const kind of ["bigint", "cycle"] as const) {
      const message = page.waitForEvent("console")
      await page.evaluate((kind) => {
        if (kind === "bigint") console.log({ nested: { count: 1n } })
        else {
          const value: { self?: unknown } = {}
          value.self = value
          console.log(value)
        }
      }, kind)
      const received = await message
      expect(await wholeText(received)).toBe(received.text())
      expect(log.at(-1)).toBe(`log: ${received.text()}`)
    }
    const message = page.waitForEvent("console")
    await page.evaluate(() => console.log({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }))
    expect(await wholeText(await message)).toContain('"six":6')
    await expect.poll(() => log.at(-1)).toContain('"six":6')
    expect(log).toHaveLength(3)
    await page.close()
  } finally { await browser.close() }
})

it("retains the preview when the browser has already disposed the argument handles", async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const next = page.waitForEvent("console")
    await page.evaluate(() => console.log({ value: 1 }))
    const message = await next
    await Promise.all(message.args().map(arg => arg.dispose()))
    expect(await wholeText(message)).toBe(message.text())
  } finally { await browser.close() }
})
