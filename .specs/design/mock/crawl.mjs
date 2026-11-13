#!/usr/bin/env node
/*
 * Verify a site mock (build.mjs --site=<name>): every screen it lists renders without page errors at desktop and
 * phone width, no screen is the not-found page, the phone layout never scrolls sideways, and every link and button
 * goes somewhere. A link is live when the site resolves its route, or when it leaves the mock with target="_blank".
 * node .specs/design/mock/crawl.mjs --dist=dist-effeck-app [--only=<screen id part>]
 */
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const { chromium } = createRequire(join(resolve(HERE, "../../../apps/app"), "package.json"))("@playwright/test")
const args = process.argv.slice(2)
const flag = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const dist = resolve(HERE, flag("dist", "dist-smithers-app"))
const only = flag("only", "")
const base = pathToFileURL(join(dist, "index.html")).href

/* Runs in the page: every interactive element's problem, if it has one. */
const audit = () => {
  const problems = []
  const site = window.__SITE__
  const label = el => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60)
  for (const a of document.querySelectorAll("a")) {
    if (a.closest("[data-mock]")) continue
    const href = a.getAttribute("href")
    if (href === null || href === "" || href === "#") { problems.push(`dead link "${label(a)}"`); continue }
    if (href.startsWith("#/")) {
      if (!site.resolve(href.slice(2))) problems.push(`link "${label(a)}" to unknown route ${href}`)
    } else if (/^https?:/.test(href)) {
      if (a.getAttribute("target") !== "_blank") problems.push(`external link "${label(a)}" without target=_blank`)
    } else if (!href.startsWith("mailto:")) problems.push(`link "${label(a)}" with unsupported href ${href}`)
    if (label(a) === "" && a.querySelector("img[alt]") === null) problems.push(`link to ${href} has no name`)
  }
  for (const button of document.querySelectorAll("button")) {
    if (button.closest("[data-mock]")) continue
    if (label(button) === "") problems.push("button with no name")
    /* React keeps handlers off the DOM: a button that does nothing must say so with data-inert="reason". */
    const props = Object.keys(button).find(key => key.startsWith("__reactProps"))
    const handled = props !== undefined && (typeof button[props].onClick === "function" || (button.type === "submit" && button.form !== null) || button.disabled)
    if (!handled && !button.hasAttribute("data-inert")) problems.push(`button "${label(button)}" does nothing`)
  }
  for (const input of document.querySelectorAll("input:not([type=hidden]), textarea, select")) {
    if (input.closest("[data-mock]")) continue
    const named = input.getAttribute("aria-label") || input.labels?.length || input.getAttribute("aria-labelledby")
    if (!named) problems.push(`field ${input.name || input.placeholder || input.tagName} has no label`)
  }
  if (document.querySelector('[data-page="404"]')) problems.push("renders the not-found page")
  const width = document.documentElement.scrollWidth
  if (width > window.innerWidth + 1) problems.push(`page scrolls sideways: ${width}px wide in a ${window.innerWidth}px window`)
  return problems
}

const browser = await chromium.launch()
const probe = await browser.newPage()
await probe.goto(`${base}?still=1#/`)
const { screens, routes } = await probe.evaluate(() => ({ screens: window.__SITE__.screens, routes: window.__SITE__.routes }))
await probe.close()

let failures = 0
const covered = new Set()
for (const screen of screens) {
  if (only !== "" && !screen.id.includes(only)) continue
  for (const [tag, width, height] of [["desk", 1440, 900], ["phone", 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } })
    const errors = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
    await page.goto(`${base}?still=1#/${screen.route}`)
    await page.waitForTimeout(screen.wait ?? 300)
    const pattern = await page.evaluate(route => window.__SITE__.resolve(route), screen.route)
    if (pattern) covered.add(pattern)
    const problems = [...errors.map(error => `page error: ${error}`), ...await page.evaluate(audit)]
    for (const problem of new Set(problems)) { failures += 1; console.log(`✗ ${screen.id} (${tag}): ${problem}`) }
    await page.close()
  }
}
if (only === "") for (const route of routes) if (!covered.has(route)) { failures += 1; console.log(`✗ route ${route} has no screen`) }
await browser.close()
console.log(`${screens.length} screens, ${routes.length} routes: ${failures === 0 ? "all ok" : `${failures} problem(s)`}`)
process.exit(failures === 0 ? 0 : 1)
