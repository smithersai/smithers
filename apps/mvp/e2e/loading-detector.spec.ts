// Static browser pages exercise the init script itself, without the app or its no-loading fixture's teardown.
import { expect } from "@playwright/test"
import { strictTest as test } from "./watch"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { Skeleton } from "@smthrs/ui";
import { uiCss as smithersUiCss } from "@smthrs/ui-css"
import { spinnersSeen, watchForSpinners } from "./fixtures"

test.beforeEach(async ({ page }) => {
  await page.addInitScript(watchForSpinners)
  // A document navigation runs the real init script and DOMContentLoaded listener, unlike setContent alone.
  await page.goto("data:text/html,<!doctype html><html><body></body></html>")
})

test("a skeleton reports its markup only after the UI's 300 ms loading hold", async ({ page }) => {
  await page.addStyleTag({ content: smithersUiCss })
  const markup = renderToStaticMarkup(createElement(Skeleton, { style: { width: 120, height: 20 } }))
  const beforePaint = await page.evaluate((html) => {
    document.body.innerHTML = html
    return new Promise<Array<string>>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      resolve([...(window as unknown as { __busy: Array<string> }).__busy])
    })))
  }, markup)
  expect(beforePaint).toEqual([])
  await expect.poll(() => spinnersSeen(page)).toEqual([markup.slice(0, 160)])
})

test("hidden and zero-sized skeletons stay unreported until they paint", async ({ page }) => {
  await page.evaluate(() => {
    document.body.innerHTML = `
      <div id="hidden" style="display:none"><div data-slot="skeleton" style="width:120px;height:20px"></div></div>
      <div data-slot="skeleton" style="visibility:hidden;width:120px;height:20px"></div>
      <div data-slot="skeleton" style="width:0;height:20px"></div>
      <div data-slot="skeleton" style="width:120px;height:0"></div>
      <div id="transparent" style="opacity:0"><div data-slot="skeleton" style="width:120px;height:20px"></div></div>`
  })
  // Let the observer and several animation frames run while every marker is unpainted.
  await page.waitForTimeout(350)
  expect(await spinnersSeen(page)).toEqual([])
  const revealed = await page.evaluate(() => {
    document.getElementById("transparent")!.style.opacity = "1"
    return document.querySelector("#transparent > div")!.outerHTML.slice(0, 160)
  })
  await expect.poll(() => spinnersSeen(page)).toEqual([revealed])
})

test("streaming answers and the router bar stay exempt; busy and progress markers still report", async ({ page }) => {
  await page.evaluate(() => {
    document.body.innerHTML = `
      <div data-answer="streaming"><div data-slot="skeleton" style="width:120px;height:20px"></div></div>
      <div role="progressbar" data-placement="page" style="width:120px;height:20px"></div>
      <div aria-busy="true" style="width:120px;height:20px"></div>
      <div role="progressbar" style="width:120px;height:20px"></div>`
  })
  const expected = await page.locator('[aria-busy="true"], [role="progressbar"]:not([data-placement="page"])')
    .evaluateAll((elements) => elements.map((element) => element.outerHTML.slice(0, 160)))
  await expect.poll(() => spinnersSeen(page)).toEqual(expected)
})
