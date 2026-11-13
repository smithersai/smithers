import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { chromium } from "playwright-core"

import { FRAMES } from "../src/script.ts"

let browser
before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    headless: true,
    args: ["--no-sandbox"]
  })
})
after(async () => { await browser?.close() })

const frameIndex = (label) => {
  const index = FRAMES.findIndex((frame) => frame.label === label)
  assert.notEqual(index, -1, label)
  return index
}

const open = async (t) => {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } })
  t.after(() => page.close())
  page.setDefaultTimeout(5000)
  await page.goto(new URL("../../flow-builder.html", import.meta.url).href)
  await page.getByRole("button", { name: "Pause", exact: true }).click()
  return page
}

const scrub = async (page, label) => {
  const index = typeof label === "number" ? label : frameIndex(label)
  await page.getByRole("slider", { name: "Scrub the demo" }).evaluate((input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(value))
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }, index)
  await page.waitForFunction((value) => document.querySelector('input[type="range"]').value === String(value), index)
}

const select = async (page, id) => {
  await page.locator(".react-flow__controls-fitview").click()
  await page.locator(`.react-flow__node[data-id="${id}"] .fl-node-title`).click()
  await page.locator(".drawer").waitFor()
}

const noDrawer = async (page) => {
  await page.locator(".drawer").waitFor({ state: "detached" })
  assert.equal(await page.locator('.fl-node[data-selected="true"]').count(), 0)
}

test("closing either a scripted or manual selection keeps the drawer dismissed", async (t) => {
  const page = await open(t)
  await scrub(page, "Re-key preview")
  await page.getByRole("button", { name: "Close", exact: true }).click()
  await noDrawer(page)

  await select(page, "writetest")
  await page.getByRole("button", { name: "Close", exact: true }).click()
  await noDrawer(page)

  await scrub(page, "Selects the node")
  await scrub(page, "Re-key preview")
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 400 } })
  await noDrawer(page)

  await scrub(page, "Selects the node")
  await scrub(page, "Re-key preview")
  await page.locator(".react-flow__controls-fitview").click()
  await page.locator('.react-flow__node[data-id="checks"] .fl-node-title').click()
  await noDrawer(page)

  await scrub(page, "Selects the node")
  await page.locator(".drawer").waitFor()
  assert.match(await page.locator(".drawer-head").innerText(), /repository\/jev-semantic-check/)
})

test("rerun progress includes cached and built nodes in the same population", async (t) => {
  const page = await open(t)
  const labels = ["8 cache hits", "Built repository/jev-semantic-check", "Built github/open-pr", "Done"]
  const expected = [73, 82, 91, 100]
  for (const [index, label] of labels.entries()) {
    await scrub(page, label)
    const run = FRAMES[frameIndex(label)].chat.find((item) => item.kind === "run" && item.title.includes("from checks"))
    assert.equal(run.total, 11)
    assert.equal(Math.round((run.built + run.clean) / run.total * 100), expected[index])
    assert.equal(await page.locator('.card[data-kind="run"]').last().locator(".card-progress > span").evaluate((bar) => bar.style.width), `${expected[index]}%`)
  }
  for (const frame of FRAMES) {
    for (const run of frame.chat.filter((item) => item.kind === "run")) {
      assert.ok(run.built + run.clean <= run.total, frame.label)
      if (run.phase === "completed") assert.equal(run.built + run.clean, run.total)
    }
  }
})

test("native controls keep their keystrokes and background playback shortcuts still work", async (t) => {
  const page = await open(t)
  await scrub(page, 20)
  const slider = page.getByRole("slider", { name: "Scrub the demo" })
  await slider.focus()
  await page.keyboard.press("ArrowRight")
  assert.equal(await slider.inputValue(), "21")
  await page.keyboard.press("ArrowLeft")
  assert.equal(await slider.inputValue(), "20")

  const picker = page.locator(".flowpick-btn")
  await picker.focus()
  await page.keyboard.press("Space")
  await page.locator(".flowpick-menu").waitFor()
  assert.equal(await page.getByRole("button", { name: "Play", exact: true }).count(), 1)
  await page.keyboard.press("Space")
  await page.locator(".flowpick-menu").waitFor({ state: "detached" })

  const theme = page.getByRole("button", { name: "Switch to light", exact: true })
  await theme.focus()
  await page.keyboard.press("Space")
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light")
  assert.equal(await page.getByRole("button", { name: "Play", exact: true }).count(), 1)

  await page.locator(".transport-label").click()
  await page.keyboard.press("ArrowRight")
  assert.equal(await slider.inputValue(), "21")
  await page.keyboard.press("ArrowLeft")
  assert.equal(await slider.inputValue(), "20")
  await page.keyboard.press("Space")
  await page.getByRole("button", { name: "Pause", exact: true }).waitFor()
  await page.keyboard.press("Space")
  await page.getByRole("button", { name: "Play", exact: true }).waitFor()

  await scrub(page, "Re-key preview")
  const close = page.getByRole("button", { name: "Close", exact: true })
  await close.focus()
  await page.keyboard.press("Space")
  await noDrawer(page)
  assert.equal(await page.getByRole("button", { name: "Play", exact: true }).count(), 1)
})

test("attempts and events follow the selected retry snapshot in both directions", async (t) => {
  const page = await open(t)
  const snapshots = [
    ["Running the suite", ["running"]],
    ["Attempt 1 fails", ["failed"]],
    ["Retry", ["failed"]],
    ["Attempt 2", ["failed", "running"]],
    ["Parked on you", ["failed", "succeeded"]],
    ["Running the suite", ["running"]],
    ["Ready", []]
  ]
  for (const [label, states] of snapshots) {
    await scrub(page, label)
    await select(page, "test")
    const tab = page.getByRole("tab", { name: /^Attempts/ })
    if (!states.length) {
      assert.equal(await tab.count(), 0)
      assert.equal(await page.getByRole("tab", { name: "Events", exact: true }).count(), 0)
      continue
    }
    await tab.click()
    assert.deepEqual(await page.locator(".attempts > li").evaluateAll((rows) => rows.map((row) => row.dataset.state)), states)
    const attempts = await page.locator(".attempts").innerText()
    if (states.includes("running")) assert.doesNotMatch(attempts, /succeeded|64s/)
    if (states[0] === "running") assert.doesNotMatch(attempts, /cold cache|failed/)
    await page.getByRole("tab", { name: "Events", exact: true }).click()
    const events = await page.locator(".journal").innerText()
    assert.match(events, /attempt-started/)
    if (label === "Running the suite") assert.doesNotMatch(events, /attempt-finished|node-settled|attempt: 2|succeeded|failed/)
    if (label === "Attempt 1 fails") {
      assert.match(events, /state: "failed"/)
      assert.doesNotMatch(events, /attempt: 2|succeeded|node-settled/)
    }
    if (label === "Retry") {
      assert.match(events, /attempt: 1, state: "failed"/)
      assert.doesNotMatch(events, /attempt: 2|succeeded|node-settled/)
    }
    if (label === "Attempt 2") {
      assert.match(events, /attempt: 2/)
      assert.doesNotMatch(events, /state: "succeeded"|node-settled/)
    }
    if (label === "Parked on you") {
      assert.match(events, /attempt: 1, state: "failed"/)
      assert.match(events, /attempt: 2, state: "succeeded"/)
      assert.match(events, /outcome: "built", attempts: 2/)
    }
  }

  await scrub(page, "8 cache hits")
  await select(page, "test")
  assert.equal(await page.getByRole("tab", { name: /^Attempts/ }).count(), 0)
  await page.getByRole("tab", { name: "Events", exact: true }).click()
  const events = await page.locator(".journal").innerText()
  assert.match(events, /outcome: "clean", attempts: 0/)
  assert.doesNotMatch(events, /attempt-started|failed|succeeded/)
})

test("human questions belong to the selected node and absent evidence has no tab", async (t) => {
  const page = await open(t)
  await scrub(page, "Parked on you")
  await select(page, "approve")
  await page.getByRole("tab", { name: "Question", exact: true }).click()
  const question = JSON.parse(await page.locator(".printed").innerText())
  assert.equal(question.name, "approve-change")
  assert.equal(question.prompt, "Land a failing test on a new change?")
  assert.equal(question.maxAttempts, 10)

  await page.locator(".flowpick-btn").click()
  await page.getByRole("option", { name: /Repair the red test, cheapest seat first/ }).click()
  await select(page, "ask-owner")
  assert.match(await page.locator(".drawer-head").innerText(), /ask-owner/)
  assert.equal(await page.getByRole("tab", { name: "Question", exact: true }).count(), 0)
  assert.doesNotMatch(await page.locator(".drawer").innerText(), /approve-change|Land a failing test/)
})

test("the drawer retains shared detail styles after retiring the Inspector", async (t) => {
  const page = await open(t)
  await scrub(page, "Re-key preview")
  await page.locator(".drawer").waitFor()
  const style = (selector, property) => page.locator(selector).first().evaluate((element, name) => getComputedStyle(element)[name], property)

  assert.equal(await style(".drawer", "display"), "grid")
  assert.equal(await style(".drawer", "animationName"), "slide")
  assert.equal(await page.evaluate(() => Array.from(document.styleSheets).some((sheet) => Array.from(sheet.cssRules).some((rule) => rule.type === CSSRule.KEYFRAMES_RULE && rule.name === "slide"))), true)
  assert.equal(await style(".inspector-glyph", "width"), "28px")
  assert.equal(await style(".inspector-foot", "display"), "flex")
  assert.equal(await style(".inspector-foot .btn", "fontSize"), "11.5px")
  assert.equal(await style(".drawer .icon-btn", "display"), "grid")

  await page.getByRole("tab", { name: "Input", exact: true }).click()
  assert.equal(await style(".ports", "display"), "flex")
  assert.equal(await style(".port-type", "flexGrow"), "1")
  assert.equal(await style(".inspector-effects", "fontSize"), "11px")
  await page.getByRole("tab", { name: "Key", exact: true }).click()
  assert.equal(await style(".keyline", "display"), "flex")
  assert.equal(await style(".keyline code", "paddingLeft"), "7px")

  await page.getByRole("button", { name: "Maximize", exact: true }).click()
  assert.equal(await page.locator(".drawer").getAttribute("data-max"), "true")
  await page.getByRole("button", { name: "Restore", exact: true }).click()
  assert.equal(await page.locator(".drawer").getAttribute("data-max"), null)
  await page.getByRole("button", { name: "Close", exact: true }).click()
  await noDrawer(page)
})
