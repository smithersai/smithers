#!/usr/bin/env node
// Opens the built site in Chromium, checks it works, and saves screenshots.
//
//   node apps/maintainer-site/screenshots.mjs
//
// Uses apps/mvp's @playwright/test. Reads ~/Desktop/smithers-maintainer (MAINTAINER_SITE_OUT) and writes
// <site>/screenshots/*.png. Fails on a console error, a page error, a failed request or a broken check.
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { hasHomeCounts } from "./screenshot-checks.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const site = resolve(process.env.MAINTAINER_SITE_OUT ?? join(homedir(), "Desktop/smithers-maintainer"))
const shots = join(site, "screenshots")
const index = pathToFileURL(join(site, "index.html")).href
const { default: playwright } = await import(pathToFileURL(join(here, "../mvp/node_modules/@playwright/test/index.mjs")).href)
const { chromium } = playwright

mkdirSync(shots, { recursive: true })
const problems = []
const check = (ok, message) => {
  if (!ok) problems.push(message)
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`)
}

const browser = await chromium.launch()
const open = async (options = {}) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ...options })
  const page = await context.newPage()
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") problems.push(`console ${message.type()}: ${message.text()}`)
  })
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`))
  page.on("requestfailed", (request) => problems.push(`request failed: ${request.url()} ${request.failure()?.errorText}`))
  return page
}
const go = async (page, hash) => {
  await page.goto(`${index}${hash}`)
  await page.waitForFunction(() => document.querySelector("#ms-main")?.children.length > 0)
}
const loadedImages = (page) =>
  page.waitForFunction(() => [...document.querySelectorAll("main img")].filter((img) => img.getBoundingClientRect().top < innerHeight).every((img) => img.complete && img.naturalWidth > 0))
// The recordings open on a blank page for a second or two; let the GIFs reach their content.
const playing = (page) => page.waitForTimeout(2500)
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) })

// Desktop, light.
const page = await open({ colorScheme: "light" })
await go(page, "#/")
check(hasHomeCounts(await page.locator(".stat-n").allTextContents()), "home shows note, flow and link counts")
check((await page.locator(".decisions li").count()) > 0, "home lists decisions")
await shot(page, "home")

await go(page, "#/flows")
await loadedImages(page)
await playing(page)
const cards = await page.locator(".flow").count()
check(cards === (await page.evaluate(() => window.SITE.flows.length)) && cards > 0, `gallery shows every flow (${cards})`)
check((await page.locator(".flow img[loading=lazy]").count()) === cards, "every GIF is lazy-loaded")
await shot(page, "flows")
await page.locator(".flow-media").first().click()
await page.waitForFunction(() => document.querySelector("#ms-lightbox")?.open && document.querySelector(".lb img")?.complete)
check(await page.locator(".lb h2").isVisible(), "clicking a GIF opens it large")
await playing(page)
await shot(page, "flow-lightbox")
await page.keyboard.press("ArrowRight")
check((await page.locator(".lb-nav span").textContent()).startsWith("2 /"), "→ steps to the next flow")
await page.keyboard.press("Escape")
check(!(await page.evaluate(() => document.querySelector("#ms-lightbox").open)), "Esc closes the large GIF")

const decision = "apps/mvp/docs/decisions/0001-electric-postgres-tanstack-db.md"
await go(page, `#/${decision}`)
const backlinks = await page.locator(".backlink-list li").count()
check(backlinks >= 2, `the decision note shows its backlinks (${backlinks})`)
check(await page.locator(".outline a").first().isVisible(), "the note shows its outline")
await shot(page, "note")
await page.locator(".backlinks").scrollIntoViewIfNeeded()
await shot(page, "note-backlinks")
const backlinkHref = await page.locator(".backlink-list a").first().getAttribute("href")
await page.locator(".backlink-list a").first().click()
await page.waitForFunction((target) => location.hash === target && document.querySelector(".md h1"), backlinkHref)
check(await page.locator(".md h1").isVisible(), `a backlink opens its note (${await page.evaluate(() => decodeURI(location.hash))})`)

await go(page, "#/apps/mvp/docs/features/chat.md#answering")
await page.waitForTimeout(100)
const top = await page.locator("#answering").evaluate((element) => Math.round(element.getBoundingClientRect().top))
check(top >= 0 && top < 80, `a heading link scrolls to the heading (top ${top}px)`)
check((await page.locator(".outline a.active").textContent()) === "Answering", "the outline marks the heading in view")

// Every in-site link in every note resolves to a note or a heading.
const broken = await page.evaluate(() => {
  const S = window.SITE
  const notes = new Set(S.notes.map((note) => note.path))
  const ids = new Map(S.notes.map((note) => [note.path, new Set([...note.html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]))]))
  const bad = []
  for (const note of S.notes) {
    const box = document.createElement("div")
    box.innerHTML = note.html
    for (const link of box.querySelectorAll('a[href^="#/"]')) {
      const hash = decodeURI(link.getAttribute("href").slice(2))
      const [path, anchor] = hash.split("#")
      if (!notes.has(path)) bad.push(`${note.path} → ${hash}`)
      else if (anchor && !ids.get(path).has(decodeURIComponent(anchor))) bad.push(`${note.path} → ${hash} (no heading)`)
    }
    for (const link of box.querySelectorAll("a.broken")) bad.push(`${note.path} → ${link.textContent} (missing)`)
  }
  return bad
})
check(broken.length === 0, `every note link resolves${broken.length ? `: ${broken.join("; ")}` : ""}`)

await go(page, "#/graph")
await page.waitForTimeout(300)
const nodes = await page.locator(".graph .node").count()
check(nodes === (await page.evaluate(() => window.SITE.notes.length)), `the graph draws every note (${nodes})`)
check((await page.locator(".graph line").count()) === (await page.evaluate(() => window.SITE.edges.length)), "the graph draws every link")
const offscreen = await page.evaluate(() => {
  const box = document.querySelector(".graph").getBoundingClientRect()
  return [...document.querySelectorAll(".graph .node")].filter((node) => {
    const rect = node.getBoundingClientRect()
    return rect.left < box.left || rect.right > box.right || rect.top < box.top || rect.bottom > box.bottom
  }).length
})
check(offscreen === 0, "every graph node fits in view")
await page.locator('.graph .node[data-id="apps/mvp/docs/state.md"]').hover()
await shot(page, "graph")
await page.locator('.graph .node[data-id="apps/mvp/docs/state.md"] circle').click()
await page.waitForFunction(() => location.hash.includes("state.md") && document.querySelector(".md h1"))
check((await page.locator(".md h1").textContent()).startsWith("State"), "clicking a graph node opens the note")

await go(page, "#/")
await page.keyboard.press("/")
check(await page.evaluate(() => document.activeElement?.id === "ms-q"), "/ focuses search")
await page.keyboard.type("electric shape", { delay: 20 })
await page.waitForFunction(() => document.querySelectorAll(".result").length > 0)
check((await page.evaluate(() => decodeURIComponent(location.hash))) === "#/search?q=electric shape", "typing filters on the search route")
const results = await page.locator(".result-note").count()
check(results > 0, `search finds notes (${results})`)
await shot(page, "search")
await page.keyboard.press("ControlOrMeta+a")
await page.keyboard.type("offline")
await page.waitForFunction(() => document.querySelectorAll(".result-flow").length > 0)
check((await page.locator(".result-flow").count()) > 0, "search finds flows by title and test name")
await playing(page)
await shot(page, "search-flows")
await page.keyboard.press("ArrowDown")
await page.keyboard.press("ArrowDown")
await page.keyboard.press("Enter")
await page.waitForTimeout(150)
check(!(await page.evaluate(() => location.hash.startsWith("#/search"))) || (await page.evaluate(() => document.querySelector("#ms-lightbox").open)), "↓ and Enter open a result")

// Work board: one column per status, one card per work note, filtered by area.
await go(page, "#/work")
const work = await page.evaluate(() => ({ items: window.SITE.work, statuses: window.SITE.workStatuses.map((status) => status.id) }))
check(work.items.length > 0, `there are work notes (${work.items.length})`)
check(
  JSON.stringify(await page.locator(".board .col").evaluateAll((columns) => columns.map((column) => column.dataset.status))) === JSON.stringify(work.statuses),
  `the board shows one column per status (${work.statuses.join(", ")})`,
)
check((await page.locator(".board .card").count()) === work.items.length, `the board shows every work note (${work.items.length})`)
const misplaced = await page.evaluate(() => {
  const byPath = new Map(window.SITE.work.map((item) => [item.path, item]))
  return [...document.querySelectorAll(".board .col")].flatMap((column) =>
    [...column.querySelectorAll(".card")].filter((card) => byPath.get(card.dataset.path)?.status !== column.dataset.status).map((card) => card.dataset.path),
  )
})
check(misplaced.length === 0, `every card sits in its status's column${misplaced.length ? `: ${misplaced.join(", ")}` : ""}`)
const openCount = work.items.filter((item) => item.status !== "done").length
check(Number(await page.locator('.nav [data-view="work"] .count').textContent()) === openCount, `the nav counts open work (${openCount})`)
check(await page.locator('.nav [data-view="work"]').evaluate((link) => link.hasAttribute("aria-current")), "the nav marks Work as current")
check(await page.evaluate(() => document.querySelector(".board").scrollWidth <= document.querySelector(".board").clientWidth), "the board fits without scrolling sideways at 1440 px")
await shot(page, "work")
const area = work.items.map((item) => item.area).find((value) => work.items.some((item) => item.area !== value))
await page.locator(`.board-areas a[href="#/work?area=${area}"]`).click()
await page.waitForFunction((value) => document.querySelector(".board-areas a[aria-current]")?.getAttribute("href") === `#/work?area=${value}`, area)
const shownAreas = await page.locator(".board .card").evaluateAll((cards) => cards.map((card) => card.dataset.area))
check(shownAreas.length === work.items.filter((item) => item.area === area).length && shownAreas.every((value) => value === area), `the ${area} filter shows only ${area} cards (${shownAreas.length})`)
check((await page.locator(".board-areas a[aria-current]").count()) === 1, "the area filter marks only its chip")
await shot(page, "work-filtered")
await page.locator(".board .card").first().click()
await page.waitForFunction(() => location.hash.includes("docs/work/") && document.querySelector(".md .props"))
check(await page.locator(".md .props .pill").isVisible(), "a card opens its note, which shows its status and properties")
check((await page.locator(".md h1").count()) === 1, "a work note shows its front-matter title once")
await shot(page, "work-note")

await go(page, "#/README.md")
check(!(await page.evaluate(() => document.querySelector("#ms-lightbox").open)), "changing route closes the large GIF")
await shot(page, "note-readme")

// Dark mode.
const dark = await open({ colorScheme: "dark" })
await go(dark, "#/")
await shot(dark, "home-dark")
await go(dark, "#/apps/mvp/docs/features/chat.md")
await shot(dark, "note-dark")
await go(dark, "#/graph")
await dark.waitForTimeout(300)
await shot(dark, "graph-dark")
await go(dark, "#/work")
await shot(dark, "work-dark")

// Phone width.
const phone = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: "light" })
for (const [hash, name] of [
  ["#/", "phone-home"],
  ["#/flows", "phone-flows"],
  ["#/work", "phone-work"],
  ["#/docs/libraries.md", "phone-note"],
  ["#/graph", "phone-graph"],
]) {
  await go(phone, hash)
  if (name === "phone-flows") await loadedImages(phone).then(() => playing(phone))
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  check(overflow <= 0, `${name}: no horizontal page scroll (${overflow}px)`)
  await shot(phone, name)
}
await go(phone, "#/")
await phone.locator("#ms-menu").tap()
check(await phone.locator("#ms-tree").isVisible(), "the phone menu opens the file tree")
await shot(phone, "phone-menu")

await browser.close()
const failures = [...new Set(problems)]
if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n${failures.map((problem) => `  ${problem}`).join("\n")}`)
  process.exit(1)
}
console.log(`\nno console errors; screenshots in ${shots}`)
