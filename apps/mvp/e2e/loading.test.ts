import { chromium, type Page } from "@playwright/test"
import { expect, test } from "vitest"
import { framesOf, framesPass, recordFrames } from "./loading"

// Recorder tests use a real Chromium DOM. They do not replace any app service or network response.
const inBrowser = async (body: (page: Page) => Promise<void>) => {
  const browser = await chromium.launch({ headless: true })
  try { await body(await browser.newPage()) } finally { await browser.close() }
}

test("navigation frames start at the click and ignore the old conversation and the shell's skeletons", () => inBrowser(async page => {
  await page.setContent('<aside><span data-slot="skeleton">PRIVATE_SHELL</span></aside><main aria-label="App"><p>PRIVATE_MESSAGE</p><span data-slot="skeleton">PRIVATE_ANSWER</span><button>Runs</button></main>')
  await recordFrames(page)
  await framesPass(page, 2)
  expect((await framesOf(page)).some(frame => frame.skeleton)).toBe(true)

  await recordFrames(page, { region: "Runs", fromClick: true })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  expect(await framesOf(page)).toEqual([])
  await page.getByRole("button", { name: "Runs" }).click()
  await framesPass(page, 2)
  const old = await framesOf(page)
  expect(old[0]!.t).toBeGreaterThanOrEqual(0)
  expect(old.every(frame => frame.main === "App" && frame.content && !frame.skeleton && !frame.spinner)).toBe(true)

  await page.evaluate(() => {
    const main = document.querySelector("main")!
    main.setAttribute("aria-label", "Runs")
    main.innerHTML = '<h1>Runs</h1><section><span data-slot="skeleton" role="progressbar">PRIVATE_LOADING</span><span data-slot="spinner">PRIVATE_SPINNER</span></section>'
  })
  await framesPass(page, 2)
  const frames = await framesOf(page)
  const destination = frames.find(frame => frame.main === "Runs")!
  expect(destination).toMatchObject({ content: true, skeleton: true, spinner: true })
  expect(destination.indicators).toContainEqual({ tag: "span", slot: "skeleton", role: "progressbar", region: "Runs", element: "section:nth-child(2) > span:nth-child(1)" })
  expect(JSON.stringify(frames)).not.toContain("PRIVATE_")
}))

test("blank or hidden route mains remain failures, while the page loading bar is global", () => inBrowser(async page => {
  await page.setContent('<div data-slot="loading-bar" data-placement="page">PRIVATE_BAR</div><main aria-label="App" style="visibility:hidden">Old</main><main aria-label="Runs"><h1>Runs</h1><span data-slot="skeleton" style="opacity:0">Hidden</span></main>')
  await recordFrames(page, { region: "Runs" })
  await framesPass(page, 2)
  expect((await framesOf(page)).at(-1)).toMatchObject({ main: "Runs", content: true, skeleton: false, bar: true })
  await page.evaluate(() => { document.querySelector("h1")!.style.opacity = "0" })
  await framesPass(page, 2)
  expect((await framesOf(page)).at(-1)).toMatchObject({ main: "Runs", content: false })
  await page.evaluate(() => { document.querySelector("h1")!.style.opacity = "1" })
  await framesPass(page, 2)
  expect((await framesOf(page)).at(-1)).toMatchObject({ main: "Runs", content: true })
  await page.evaluate(() => document.querySelector('main[aria-label="Runs"]')!.replaceChildren())
  await framesPass(page, 2)
  expect((await framesOf(page)).at(-1)).toMatchObject({ main: "Runs", content: false })
  await page.evaluate(() => document.querySelector('main[aria-label="Runs"]')!.setAttribute("hidden", ""))
  await framesPass(page, 2)
  expect((await framesOf(page)).at(-1)).toMatchObject({ main: null, content: false })
  const frames = await framesOf(page)
  expect(JSON.stringify(frames)).not.toContain("PRIVATE_")
  expect(frames[0]!.indicators[0]!.element).toBe("html > body:nth-child(2) > div:nth-child(1)")
}))

test("repository frames retain body, placeholder and header evidence without content or markup", () => inBrowser(async page => {
  await page.setContent('<main aria-label="Repository"><header aria-label="Repository">PRIVATE_HEADER</header><section><span data-slot="skeleton" style="display:block;height:12px;opacity:0"></span></section></main>')
  await recordFrames(page)
  await framesPass(page, 2)
  expect((await framesOf(page)).at(-1)).toMatchObject({ repository: false, placeholder: false })
  await page.evaluate(() => { document.querySelector("span")!.style.opacity = "1" })
  await framesPass(page, 2)
  expect((await framesOf(page)).at(-1)).toMatchObject({ repository: false, placeholder: true })
  await page.evaluate(() => { document.querySelector("section")!.textContent = "PRIVATE_README" })
  await framesPass(page, 2)
  const frames = await framesOf(page)
  expect(frames.at(-1)).toMatchObject({ repository: true, placeholder: false, skeleton: false })
  expect(frames.every(frame => frame.header?.join() === frames[0]!.header?.join())).toBe(true)
  expect(JSON.stringify(frames)).not.toContain("PRIVATE_")
}))
