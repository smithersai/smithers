#!/usr/bin/env node
// Drives the whole queue by keyboard alone in Chromium, on a fixture of every kind, and saves light and dark
// screenshots of each kind to apps/maintainer-site/screenshots/queue-<kind>-<theme>.png.
//
//   node apps/maintainer-site/test/queue.e2e.mjs
//
// Uses apps/mvp's @playwright/test. Starts its own server on a free port over a copy of test/fixtures; never touches
// queue/. Fails on a console error, a page error, a failed request or a broken check.
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { startServer } from "../serve.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, "fixtures")
const shots = join(here, "..", "screenshots")
const { default: playwright } = await import(pathToFileURL(join(here, "../../mvp/node_modules/@playwright/test/index.mjs")).href)

const dir = mkdtempSync(join(tmpdir(), "queue-e2e-"))
const repo = join(dir, "repo")
const queueDir = join(dir, "queue")
cpSync(join(fixtures, "repo"), repo, { recursive: true })
mkdirSync(queueDir)
// Verify items compare against old recordings and files the curator keeps in queue/before/<id>/.
writeFileSync(join(queueDir, "queue.json"), readFileSync(join(fixtures, "queue.json"), "utf8").replaceAll("$QUEUE", queueDir))
copyFileSync(join(fixtures, "answers.jsonl"), join(queueDir, "answers.jsonl"))
for (const [id, files] of Object.entries({
  "verify-chat-shortcut-speed": ["chat-shortcut-old.mp4", "chat-shortcut-old.chapters.json"],
  "verify-shape-stream-limit": ["shape-stream.old.ts"],
  "verify-status-pill-contrast": ["status-old.html"],
})) {
  mkdirSync(join(queueDir, "before", id), { recursive: true })
  for (const file of files) copyFileSync(join(fixtures, "before", file), join(queueDir, "before", id, file))
}
mkdirSync(shots, { recursive: true })

const server = startServer({ port: 0, repo, gifs: join(repo, "gifs"), site: repo, queueDir })
const base = await server.ready
const url = `${base}/queue`

const problems = []
// The browser logs a refused answer's response as a console error; a check that expects one names it here.
let expectedRefusal = null
const check = (ok, message) => {
  if (!ok) problems.push(message)
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`)
}
const answers = () =>
  readFileSync(join(queueDir, "answers.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .slice(1)

const browser = await playwright.chromium.launch()
const open = async (options = {}) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options })
  const page = await context.newPage()
  page.on("console", (message) => {
    if (expectedRefusal && message.type() === "error" && message.text().includes(expectedRefusal)) return
    if (message.type() === "error" || message.type() === "warning") problems.push(`console ${message.type()}: ${message.text()}`)
  })
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`))
  page.on("requestfailed", (request) => {
    // Leaving a page aborts its event stream and in-flight media; that is not a failure.
    const failure = request.failure()?.errorText ?? ""
    if (!/ERR_ABORTED/.test(failure)) problems.push(`request failed: ${request.url()} ${failure}`)
  })
  return page
}
const currentId = (page) => page.evaluate(() => document.querySelector(".q-card:not(.leaving)")?.dataset.id ?? null)
const settled = (page) => page.waitForFunction(() => !document.querySelector(".q-card.leaving") && !document.querySelector(".q-card.enter-up, .q-card.enter-down"))
const showing = async (page, id) => {
  await page.waitForFunction((id) => document.querySelector(".q-card:not(.leaving)")?.dataset.id === id, id, { timeout: 5000 }).catch(() => {})
  await settled(page)
  return (await currentId(page)) === id
}
const waitAnswers = (count) => new Promise((resolve) => {
  const start = Date.now()
  const poll = () => (answers().length >= count || Date.now() - start > 3000 ? resolve(answers()) : setTimeout(poll, 25))
  poll()
})
// The answer the last key sent: waits for one more line in answers.jsonl.
let sentCount = 0
const nextAnswer = async () => (await waitAnswers(++sentCount))[sentCount - 1] ?? null
const SHOT = { "design:shape-stream-readme@77aa": "readme", "verify:shape-stream-limit": "verify-code", "verify:status-pill-contrast": "verify-design", "verify:chat-opens-in-time": "verify-pinned" }
const videoOf = (item) => [item.media?.[0], item.after?.media].find((media) => media?.type === "video")

// ---------------------------------------------------------------------------------------------------------
// Screenshots: every kind, light and dark.

const items = (await (await fetch(`${base.replace("localhost", "127.0.0.1")}/api/queue`, { headers: { host: new URL(base).host } })).json()).items
for (const colorScheme of ["light", "dark"]) {
  const page = await open({ colorScheme })
  for (const item of items) {
    await page.goto(`${url}#${encodeURIComponent(item.id)}`)
    await showing(page, item.id)
    if (item.kind === "code" || item.after?.media?.type === "code") await page.waitForSelector(".q-line")
    if (item.media?.[0]?.type === "md") await page.waitForSelector(".q-md h1")
    const frames = await page.locator(".q-card:not(.leaving) .q-frame").count()
    for (let index = 0; index < frames; index++) await page.frameLocator(".q-card:not(.leaving) .q-frame").nth(index).locator("#script-ran").filter({ hasText: "ran" }).waitFor()
    await page.waitForFunction(() => [...document.querySelectorAll(".q-card:not(.leaving) img")].every((img) => img.complete && img.naturalWidth > 0))
    // A recording: hold it on a moment with content, its chapter lit on the timeline. One with Will's notes opens on
    // the first of them by itself.
    if (videoOf(item)) await page.waitForFunction(() => document.querySelectorAll(".q-seg").length > 0)
    if (videoOf(item) && !item.before) {
      await page.locator(".q-video").evaluate(
        (video) =>
          new Promise((resolve) => {
            video.pause()
            video.addEventListener("seeked", resolve, { once: true })
            video.currentTime = 3.6
          }),
      )
    }
    // The recordings open on a blank page for about three seconds; let the GIFs reach their content.
    await page.waitForTimeout(item.media?.[0]?.type === "gif" ? 4000 : 300)
    if (item.before?.media?.type === "video") await page.waitForFunction(() => !document.querySelector(".q-pin-note").hidden)
    await page.screenshot({ path: join(shots, `queue-${SHOT[item.id] ?? item.kind}-${colorScheme}.png`) })
    // The same code review with g pressed: the note applies to every code review.
    if (item.kind === "code") {
      await page.keyboard.press("g")
      await page.locator(".q-box").fill("Every slice needs a diagram of how its files connect.")
      await page.keyboard.press("Escape")
      await page.screenshot({ path: join(shots, `queue-code-scope-${colorScheme}.png`) })
      await page.locator(".q-box").fill("")
      await page.keyboard.press("Escape")
      await page.keyboard.press("g")
    }
  }
  await page.context().close()
}
console.log(`ok   screenshots of ${items.length} items, light and dark, in ${shots}`)

// ---------------------------------------------------------------------------------------------------------
// The whole queue by keyboard.

const page = await open({ colorScheme: "light" })
await page.goto(url)
const press = (key) => page.keyboard.press(key)

// Decision: an option key with an empty box answers at once.
check(await showing(page, "decision:electric-shapes"), "the highest priority item comes first")
check((await page.locator("#q-total").textContent()) === "10", "the header counts 10 items")
check((await page.locator(".q-kind").count()) === 6, "the header counts each kind")
check((await page.locator(".q-option kbd").allTextContents()).join("") === "123", "every option shows its key")
await press("?")
check(await page.locator(".q-sheet-box").isVisible(), "? opens the key sheet")
await press("Escape")
check(await page.locator(".q-sheet").isHidden(), "Esc closes the key sheet")
await press("o")
await page.waitForSelector(".q-viewer .q-line")
check((await page.locator(".q-viewer .q-path").textContent()).includes("src/shape-stream.ts"), "o opens the linked file inline")
check(page.url() === url, "o stays on the page")
await press("Escape")
check(await page.locator(".q-viewer").isHidden(), "Esc closes the inline file")
await press("2")
let last = await nextAnswer()
check(last?.itemId === "decision:electric-shapes" && last.action === "option" && last.option === "2" && last.text === "", "2 chooses option 2 at once")
check((await page.locator("#q-done").textContent()) === "1", "the header counts 1 done today")

// Code: J/K switch files, j/k scroll, a picks with text in the box, ⌘Enter sends.
check(await showing(page, "code:shape-stream@3f2a"), "the next item slides in: the code slice")
await page.waitForSelector(".q-line")
check((await page.locator(".q-note").textContent()).includes("push()"), "the file's note shows above it")
check((await page.locator(".q-note code").count()) === 2, "backticks in the note render as code")
check((await page.locator(".q-ln").first().textContent()) === "1", "lines are numbered")
check((await page.locator(".q-lc .tk").count()) > 5 && (await page.locator(".q-lc .ts").count()) > 2 && (await page.locator(".q-lc .tc").count()) > 2, "the code is coloured: keywords, strings, comments")
const scrollTop = () => page.locator(".q-code-scroll").evaluate((element) => element.scrollTop)
await press("j")
await press("j")
await page.waitForFunction(() => document.querySelector(".q-code-scroll").scrollTop > 0)
check((await scrollTop()) > 0, "j scrolls the code down")
const down = await scrollTop()
await press("k")
await page.waitForFunction((down) => document.querySelector(".q-code-scroll").scrollTop < down, down)
check((await scrollTop()) < down, "k scrolls it up")
await press("Shift+J")
await page.waitForSelector(".q-tab.on:has-text('shape-stream.css')")
check((await page.locator(".q-path").textContent()) === "src/shape-stream.css", "J opens the next file")
await page.waitForSelector(".q-line")
await press("Shift+K")
await page.waitForSelector(".q-tab.on:has-text('shape-stream.ts')")
check(true, "K opens the previous file")
await press("i")
check(await page.locator(".q-box").evaluate((element) => element === document.activeElement), "i focuses the box")
await page.keyboard.type("L20: a2lu jk JK np")
check((await page.locator(".q-box").inputValue()) === "L20: a2lu jk JK np", "keys typed in the box stay in the box")
check(answers().length === 1, "typing sends nothing")
await press("Escape")
check(await page.locator(".q-box").evaluate((element) => element !== document.activeElement), "Esc leaves the box")
await press("a")
check(await page.locator(".q-act.primary.picked").isVisible(), "with text, a picks Looks good")
check(answers().length === 1, "with text, a does not send")
check(await page.locator(".q-scope").isHidden(), "a note applies to this item alone by default")
await press("g")
check(await page.locator(".q-scope").isVisible(), "g marks the note as applying to every item of this kind")
check((await page.locator(".q-scope").textContent()).includes("all code reviews"), "the badge names the kind")
check((await page.locator("#q-keys").textContent()).includes("applies to all"), "the key bar shows g")
await press("Meta+Enter")
last = await nextAnswer()
check(last?.action === "approve" && last.text === "L20: a2lu jk JK np" && last.revision === "3f2a9c1e7b", "⌘Enter sends approve with the text and revision")
check(last?.scope === "all" && last.kind === "code", "the answer records the scope and the kind")
await page.waitForSelector(".q-toast:not([hidden])")
check((await page.locator(".q-toast").textContent()) === "Sent for all code reviews", "a toast confirms the scope")
check(await showing(page, "design:status-pill@9124"), "the design comes next")
await press("u")
last = await nextAnswer()
check(last?.action === "undo" && last.itemId === "code:shape-stream@3f2a", "u undoes the scoped answer")
check(await showing(page, "code:shape-stream@3f2a"), "the code review comes back")
await page.waitForSelector(".q-line")
check((await page.locator(".q-box").inputValue()) === "L20: a2lu jk JK np" && (await page.locator(".q-scope").isVisible()), "with its text and its scope")
await press("g")
check(await page.locator(".q-scope").isHidden(), "g again clears the scope")
await press("g")
await press("Meta+Enter")
last = await nextAnswer()
check(last?.action === "changes" && last.scope === "all" && last.kind === "code", "the note goes again, for all code reviews")

// Design: n/p switch media; r focuses the box; ⌘Enter sends the changes.
check(await showing(page, "design:status-pill@9124"), "the design comes next")
await page.frameLocator(".q-frame").locator("#script-ran").filter({ hasText: "ran" }).waitFor()
check(true, "the design renders in a sandboxed frame and its script runs")
check((await page.locator(".q-frame").getAttribute("sandbox")) === "allow-scripts", "the frame is sandboxed without same-origin")
await press("n")
await page.waitForSelector(".q-media img")
check((await page.locator(".q-path").textContent()).endsWith("status.svg"), "n shows the next media item")
await press("p")
await page.waitForSelector(".q-frame")
check(true, "p shows the previous media item")
await press("r")
check(await page.locator(".q-box").evaluate((element) => element === document.activeElement), "r focuses the box")
await page.keyboard.type("Tighter spacing between pills.")
check(await page.locator(".q-scope").isHidden(), "the scope never carries over to the next item")
await press("Meta+Enter")
last = await nextAnswer()
check(last?.action === "changes" && last.text === "Tighter spacing between pills." && last.scope === undefined, "r then ⌘Enter requests changes")

// A README: rendered like GitHub; j/k scroll it, o shows its source, its links open in a new tab.
check(await showing(page, "design:shape-stream-readme@77aa"), "the README comes next")
await page.waitForSelector(".q-md h1")
const doc = page.locator(".q-card:not(.leaving) .q-md")
check((await doc.locator("h1").textContent()) === "ShapeStream" && (await doc.locator("h2").count()) === 7, "headings render")
check((await doc.locator("table th").count()) === 3 && (await doc.locator("ul li").count()) === 3 && (await doc.locator("ol li").count()) === 3, "tables and lists render")
check((await doc.locator("pre code .tk").count()) > 0 && (await doc.locator("pre code .tc").count()) > 0 && (await doc.locator("pre code .ts").count()) > 0, "code blocks are coloured")
check((await doc.locator(".callout-note").count()) === 1, "a GitHub note renders as a callout")
await page.waitForFunction(() => document.querySelector(".q-card:not(.leaving) .q-md img")?.complete)
check(await doc.locator("img").evaluate((img) => img.naturalWidth > 0 && img.getAttribute("src") === "/api/file?path=design%2Fstatus.svg"), "an image from the repository shows")
check((await doc.locator("script").count()) === 0 && (await page.title()) === "Queue", "raw HTML in the file is sanitized")
const outward = doc.locator("a[href^='/api/file'], a[href^='http']")
check((await outward.evaluateAll((links) => links.every((link) => link.target === "_blank" && link.rel.includes("noopener")))) && (await outward.count()) === 2, "links open in a new tab")
const docTop = () => page.locator(".q-card:not(.leaving) .q-doc").evaluate((element) => element.scrollTop)
await press("j")
await press("j")
await page.waitForFunction(() => document.querySelector(".q-card:not(.leaving) .q-doc").scrollTop > 0)
check((await docTop()) > 0, "j scrolls the README")
const docDown = await docTop()
await press("k")
await page.waitForFunction((down) => document.querySelector(".q-card:not(.leaving) .q-doc").scrollTop < down, docDown)
check((await docTop()) < docDown, "k scrolls it back")
await press("o")
await page.waitForSelector(".q-viewer .q-line")
check((await page.locator(".q-viewer .q-line").first().textContent()).includes("# ShapeStream"), "o shows the raw source")
await press("Escape")
check(await page.locator(".q-viewer").isHidden(), "Esc closes the source")
check((await page.locator("#q-keys").textContent()).includes("source"), "the key bar shows o for the source")
const [tab] = await Promise.all([page.context().waitForEvent("page"), doc.locator("a", { hasText: "src/shape-stream.ts" }).click()])
await tab.waitForLoadState()
check(tab.url().endsWith("/api/file?path=src%2Fshape-stream.ts") && page.url().startsWith(url), "a repository link opens in a new tab and the queue stays")
await tab.close()
await doc.locator("a[href='#install']").click()
await page.waitForFunction(() => {
  const heading = document.querySelector(".q-card:not(.leaving) .q-md #install").getBoundingClientRect()
  const box = document.querySelector(".q-card:not(.leaving) .q-doc").getBoundingClientRect()
  return Math.abs(heading.top - box.top) < 40
}, null, { timeout: 3000 }).catch(() => {})
check(await page.evaluate(() => Math.abs(document.querySelector(".q-card:not(.leaving) .q-md #install").getBoundingClientRect().top - document.querySelector(".q-card:not(.leaving) .q-doc").getBoundingClientRect().top) < 40), "an #anchor scrolls the README to its heading")
check(page.url() === url, "an #anchor leaves the queue's address alone")
await press("a")
last = await nextAnswer()
check(last?.action === "approve" && last.itemId === "design:shape-stream-readme@77aa", "a approves the README")

// A feature recording: the review player, its chapter timeline, and a note pinned to a moment.
check(await showing(page, "gif:chat-shortcut@bf47"), "the recording comes next")
await press("n")
await page.waitForSelector(".q-media img")
await page.waitForFunction(() => document.querySelector(".q-card:not(.leaving) .q-media img")?.complete, null, { timeout: 5000 }).catch(() => {})
check(await page.locator(".q-media img").evaluate((img) => img.complete && img.naturalWidth > 0), "a GIF still plays as before")
await press("p")
await page.waitForFunction(() => document.querySelectorAll(".q-seg").length === 4)
check(true, "the timeline shows every chapter")
check((await page.locator(".q-tick").count()) === 3, "a tick marks each chapter after the first")
check((await page.locator(".q-seg").allTextContents()).join("|") === "Open the app|Sign in|Open chat|Scroll the answer", "the chapters carry their labels")
const video = page.locator(".q-video")
const time = () => video.evaluate((element) => element.currentTime)
const paused = () => video.evaluate((element) => element.paused)
const near = async (seconds) => Math.abs((await time()) - seconds) < 0.01
const lit = () => page.locator(".q-seg.on").textContent()
await page.waitForFunction(() => !document.querySelector(".q-video").paused, null, { timeout: 5000 }).catch(() => {})
check(!(await paused()), "the recording plays at once")
await press(" ")
check(await paused(), "space pauses")
await press(" ")
check(!(await paused()), "space plays")
await press(" ")
await press("0")
check(await near(0), "0 goes back to the start")
check((await lit()) === "Open the app", "the current chapter is lit")
await press("]")
check((await near(1.5)) && (await lit()) === "Sign in", "] jumps to the next chapter and lights it")
await press("]")
check((await near(3.1)) && (await lit()) === "Open chat", "] again jumps to the chapter after")
check((await page.locator(".q-tick.on").getAttribute("data-t")) === "3.1", "the chapter's tick is lit too")
await press("[")
check(await near(1.5), "[ jumps to the previous chapter")
await press("ArrowRight")
check((await near(3.5)) && (await lit()) === "Open chat", "→ skips ahead 2 s")
await press("ArrowLeft")
check(await near(1.5), "← skips back 2 s")
await press(".")
check((await paused()) && (await near(1.5 + 1 / 30)), ". steps one frame ahead, paused")
await press(",")
check(await near(1.5), ", steps one frame back")
const rate = () => video.evaluate((element) => element.playbackRate)
await press(">")
// The label repaints on the video's ratechange event, a task after the key.
await page.waitForFunction(() => document.querySelector(".q-speed b")?.textContent === "1.25×", null, { timeout: 2000 }).catch(() => {})
check((await rate()) === 1.25 && (await page.locator(".q-speed b").textContent()) === "1.25×", "> speeds up")
for (let index = 0; index < 6; index++) await press(">")
check((await rate()) === 2, "speed stops at 2×")
for (let index = 0; index < 8; index++) await press("<")
check((await rate()) === 0.5, "< slows down to 0.5×")
await page.locator(".q-seg", { hasText: "Scroll the answer" }).click()
check((await near(4)) && (await lit()) === "Scroll the answer", "clicking a chapter seeks to it")
await page.locator(".q-tick[data-t='1.5']").click()
check(await near(1.5), "clicking a tick seeks to it")
await press("ArrowRight")
await press("i")
check((await page.locator(".q-box").inputValue()) === "[00:03 Open chat] ", "a note starts with the moment: time and chapter")
check(await paused(), "typing a note pauses the recording")
await press("Escape")
check((await page.locator(".q-box").inputValue()) === "", "leaving the box untouched drops the stamp")
await press("ArrowLeft")
await press("i")
await page.keyboard.type("The answer jumps.")
await press("Meta+Enter")
last = await nextAnswer()
check(last?.action === "changes" && last.text === "[00:01 Sign in] The answer jumps.", "the sent note points at its moment")

// Verify with both recordings: side by side on one timeline, opening on Will's first note.
check(await showing(page, "verify:chat-shortcut-speed"), "the verify item with before and after recordings comes next")
check((await page.locator(".q-said").textContent()).includes("The chat opens too late."), "verify shows what you said")
check((await page.locator(".q-act.primary").textContent()).includes("Fixed"), "verify's approve reads Fixed")
await page.waitForFunction(() => document.querySelectorAll(".q-card:not(.leaving) .q-seg").length === 4)
check((await page.locator(".q-card:not(.leaving) .q-pane").count()) === 2, "before and after play side by side")
const afterVideo = page.locator(".q-card:not(.leaving) .q-video")
const beforeVideo = page.locator(".q-card:not(.leaving) .q-video-before")
const at = (locator) => locator.evaluate((element) => element.currentTime)
// Will's first note: [00:05 Open chat] on the old recording, 0.35 s into Open chat, which starts at 3.1 s in the new one.
await page.waitForFunction(() => Math.abs(document.querySelector(".q-card:not(.leaving) .q-video").currentTime - 3.45) < 0.01, null, { timeout: 5000 }).catch(() => {})
check(Math.abs((await at(afterVideo)) - 3.45) < 0.01 && (await afterVideo.evaluate((element) => element.paused)), "the pair opens paused on the moment of your first note")
await page.waitForFunction(() => !document.querySelector(".q-card:not(.leaving) .q-pin-note").hidden, null, { timeout: 5000 }).catch(() => {})
check(Math.abs((await at(beforeVideo)) - 5) < 0.05, "the before recording shows the same moment")
const pinned = await page.locator(".q-card:not(.leaving) .q-pin-note").textContent()
check(pinned.includes("[00:05 Open chat]") && pinned.includes("The chat opens too late."), "your note is pinned on the old recording at its moment")
const panes = await page.locator(".q-card:not(.leaving) .q-pane").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()))
const videos = await page.locator(".q-card:not(.leaving) .q-pane video").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect()))
check(videos.every((box, index) => box.left >= panes[index].left - 1 && box.right <= panes[index].right + 1), "each recording stays inside its own pane")
check((await page.locator(".q-card:not(.leaving) .q-pin").count()) === 2, "each stamped note has a pin on the timeline")
await press("]")
check(Math.abs((await at(afterVideo)) - 4) < 0.01 && Math.abs((await at(beforeVideo)) - 6) < 0.01, "the chapters line up: the old recording follows to the same chapter")
await press("b")
check((await page.locator(".q-pane.after").isHidden()) && (await page.locator(".q-pane.before").isVisible()) && (await page.locator(".q-mode b").textContent()) === "Before", "b shows the before recording alone")
await press("b")
check((await page.locator(".q-pane.before").isHidden()) && (await page.locator(".q-pane.after").isVisible()), "b again shows the after recording alone")
await press("b")
check((await page.locator(".q-pane").evaluateAll((panes) => panes.every((pane) => pane.checkVisibility()))) && (await page.locator(".q-mode b").textContent()) === "Both", "b again shows both")
await press(" ")
await page.waitForFunction(() => !document.querySelector(".q-card:not(.leaving) .q-video-before").paused, null, { timeout: 3000 }).catch(() => {})
check(!(await afterVideo.evaluate((element) => element.paused)) && !(await beforeVideo.evaluate((element) => element.paused)), "space plays both")
await press(" ")
await page.waitForFunction(() => document.querySelector(".q-card:not(.leaving) .q-video-before").paused, null, { timeout: 3000 }).catch(() => {})
check(await beforeVideo.evaluate((element) => element.paused), "space pauses both")
await press("a")
last = await nextAnswer()
check(last?.action === "approve" && last.itemId === "verify:chat-shortcut-speed", "a confirms the fix")

// Verify a code fix: a diff, with Will's line note on the old line.
check(await showing(page, "verify:shape-stream-limit"), "the code fix comes next")
await page.waitForSelector(".q-diff .q-line")
check((await page.locator(".q-line.add").count()) === 2 && (await page.locator(".q-line.del").count()) === 2, "the diff shows the changed lines")
check((await page.locator(".q-diff-count").textContent()) === "+2 −2", "the diff counts additions and removals")
check((await page.locator(".q-line.pinned .q-ln").first().textContent()) === "16", "your line note marks the old line")
check((await page.locator(".q-pin-row").textContent()).includes("the limit should come from the caller"), "and shows what you said under it")
check((await page.locator(".q-fold").count()) > 0, "unchanged runs fold away")
await press("a")
last = await nextAnswer()
check(last?.action === "approve" && last.itemId === "verify:shape-stream-limit", "a confirms the code fix")

// Verify a design fix: the old and new mocks side by side.
check(await showing(page, "verify:status-pill-contrast"), "the design fix comes next")
for (let index = 0; index < 2; index++) await page.frameLocator(".q-card:not(.leaving) .q-frame").nth(index).locator("#script-ran").filter({ hasText: "ran" }).waitFor()
check((await page.locator(".q-card:not(.leaving) .q-pane .q-frame[sandbox='allow-scripts']").count()) === 2, "the old and new designs show side by side, sandboxed")
await press("b")
check((await page.locator(".q-pane.after").isHidden()) && (await page.locator(".q-pane.before").isVisible()), "b shows the old design alone")
await press("b")
await press("b")
await press("r")
await page.keyboard.type("Better; one more step of contrast.")
await press("Meta+Enter")
last = await nextAnswer()
check(last?.action === "changes" && last.itemId === "verify:status-pill-contrast" && last.text === "Better; one more step of contrast.", "r then ⌘Enter says the design fix needs more")

// Verify without the old recording: the note is pinned on the new one.
check(await showing(page, "verify:chat-opens-in-time"), "the fix without an old recording comes next")
await page.waitForFunction(() => document.querySelectorAll(".q-card:not(.leaving) .q-seg").length === 4)
await page.waitForFunction(() => Math.abs(document.querySelector(".q-card:not(.leaving) .q-video").currentTime - 3.1) < 0.01, null, { timeout: 5000 }).catch(() => {})
const lone = page.locator(".q-card:not(.leaving) .q-video")
check(Math.abs((await at(lone)) - 3.1) < 0.01 && (await lone.evaluate((element) => element.paused)), "the recording opens paused at your note, inside the chapter it names")
const note = page.locator(".q-card:not(.leaving) .q-pin-note")
check((await note.isVisible()) && (await note.textContent()).includes("[00:03 Open chat]") && (await note.textContent()).includes("The chat opens too late."), "your note is pinned on the new recording")
check((await page.locator(".q-card:not(.leaving) .q-pin").count()) === 1, "its pin sits on the timeline")
await press("0")
check(await note.isHidden(), "the note shows only around its moment")
await press("a")
last = await nextAnswer()
check(last?.action === "approve" && last.itemId === "verify:chat-opens-in-time", "a confirms it")

// Question: / focuses; with text, 1 picks; ⌘Enter sends both.
check(await showing(page, "question:scratch-repo"), "the question comes last")
await press("/")
await page.keyboard.type("Name it queue-scratch.")
await press("Escape")
await press("1")
check(await page.locator(".q-option.picked").isVisible(), "with text, 1 picks option 1")
check(answers().length === sentCount, "picking sends nothing")
await press("Meta+Enter")
last = await nextAnswer()
check(last?.action === "option" && last.option === "1" && last.text === "Name it queue-scratch.", "⌘Enter sends the option with the text")
await page.waitForSelector(".q-empty")
check((await page.locator(".q-empty .q-title").textContent()) === "Queue empty", "an empty queue says so")

// Undo brings the last item back with its text.
await press("u")
last = await nextAnswer()
check(last?.action === "undo" && last.itemId === "question:scratch-repo", "u appends an undo")
check(await showing(page, "question:scratch-repo"), "u brings the item back")
check((await page.locator(".q-box").inputValue()) === "Name it queue-scratch.", "the undone answer's text is back in the box")

// A draft survives a reload.
await page.locator(".q-box").fill("A draft that must survive.")
await page.reload()
check(await showing(page, "question:scratch-repo"), "after a reload the same item is current")
check((await page.locator(".q-box").inputValue()) === "A draft that must survive.", "the draft survives a reload")

// A live reorder from the curator moves the counter, never the item under Will's hands.
const queue = JSON.parse(readFileSync(join(queueDir, "queue.json"), "utf8"))
queue.items.push({ id: "decision:urgent", kind: "decision", title: "Urgent: a new decision", priority: 999, why: "Landed now", area: "process", addedAt: new Date().toISOString(), context: "New.", options: [{ key: "1", label: "Yes" }] })
writeFileSync(join(queueDir, "queue.json.tmp"), JSON.stringify(queue))
renameSync(join(queueDir, "queue.json.tmp"), join(queueDir, "queue.json"))
await page.waitForFunction(() => document.querySelector("#q-total").textContent === "2", null, { timeout: 5000 }).catch(() => {})
check((await page.locator("#q-total").textContent()) === "2", "a live update recounts the queue")
check((await currentId(page)) === "question:scratch-repo", "a live update leaves the current item in place")
check((await page.locator(".q-box").inputValue()) === "A draft that must survive.", "a live update keeps the typed text")
await page.locator(".q-box").fill("")
await press("Escape")
await press("l")
check(await showing(page, "decision:urgent"), "after answering, the new highest priority item comes next")
check(answers().at(-1)?.action === "later", "l snoozes at once with an empty box")

// The curator replaces the open item: an answer to the old version is refused, and the new version takes its place.
const replaced = JSON.parse(readFileSync(join(queueDir, "queue.json"), "utf8"))
Object.assign(replaced.items.find((item) => item.id === "decision:urgent"), { title: "Urgent: a changed decision", addedAt: new Date(Date.now() + 1000).toISOString() })
writeFileSync(join(queueDir, "queue.json.tmp"), JSON.stringify(replaced))
renameSync(join(queueDir, "queue.json.tmp"), join(queueDir, "queue.json"))
await page.waitForTimeout(500)
check((await page.locator(".q-card:not(.leaving) .q-title").textContent()) === "Urgent: a new decision", "a live update leaves the version Will is reading")
expectedRefusal = "409"
await press("1")
check(await showing(page, "decision:urgent"), "an answer to a replaced item brings the item back")
await page.waitForFunction(() => document.querySelector(".q-card:not(.leaving) .q-title")?.textContent === "Urgent: a changed decision", null, { timeout: 5000 }).catch(() => {})
check((await page.locator(".q-card:not(.leaving) .q-title").textContent()) === "Urgent: a changed decision", "the refused answer shows the new version")
check(answers().at(-1)?.action === "later", "the refused answer writes nothing")
expectedRefusal = null

// With reduced motion the item changes at once, with no slide.
const still = await open({ colorScheme: "light", reducedMotion: "reduce" })
await still.goto(url)
await showing(still, "decision:urgent")
check((await still.evaluate(() => getComputedStyle(document.querySelector(".q-card")).transitionDuration)) === "0.001s", "reduced motion turns the slide off")
await still.context().close()

// Every visible button names its key.
const unlabeled = await page.locator(".q-card:not(.leaving) :is(.q-act, .q-option):not(:has(kbd))").count()
check(unlabeled === 0 && (await page.locator(".q-card:not(.leaving) .q-act").count()) > 0, "every action button shows its key")

// An earlier answer that fails after a later one was saved removes only itself: the card Will has started on stays,
// and u undoes the later, saved answer. Its own context: the failed request logs a console error on purpose.
const raced = JSON.parse(readFileSync(join(queueDir, "queue.json"), "utf8"))
for (const [id, priority] of [["decision:race-first", 1001], ["decision:race-second", 1000]])
  raced.items.push({ id, kind: "decision", title: id, priority, why: "Race", area: "process", addedAt: new Date().toISOString(), context: "Race.", options: [{ key: "1", label: "Yes" }] })
writeFileSync(join(queueDir, "queue.json.tmp"), JSON.stringify(raced))
renameSync(join(queueDir, "queue.json.tmp"), join(queueDir, "queue.json"))
const raceContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const race = await raceContext.newPage()
race.on("pageerror", (error) => problems.push(`page error: ${error.message}`))
let releaseFirst
const firstHeld = new Promise((resolve) => (releaseFirst = resolve))
await race.route("**/api/answer", async (route) => {
  if (JSON.parse(route.request().postData()).itemId !== "decision:race-first") return route.continue()
  await firstHeld
  await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "disk full" }) })
})
await race.goto(url)
sentCount = answers().length
check(await showing(race, "decision:race-first"), "the first race item is current")
await race.keyboard.press("1")
check(await showing(race, "decision:race-second"), "the second comes next while the first is still sending")
await race.keyboard.press("1")
last = await nextAnswer()
check(last?.itemId === "decision:race-second", "the second answer is saved")
check(await showing(race, "decision:urgent"), "the next item comes up")
await race.keyboard.press("/")
await race.keyboard.type("Started on this one.")
releaseFirst()
await race.waitForSelector(".q-toast:not([hidden])")
check((await race.locator(".q-toast").textContent()) === "Not saved: disk full", "the failed first answer says so")
check((await currentId(race)) === "decision:urgent" && (await race.locator(".q-box").inputValue()) === "Started on this one.", "the failure leaves the card Will started on")
await race.keyboard.press("Escape")
await race.keyboard.press("u")
last = await nextAnswer()
check(last?.action === "undo" && last.itemId === "decision:race-second", "u undoes the saved second answer, not the failed first")
await raceContext.close()

await browser.close()
await server.close()
rmSync(dir, { recursive: true, force: true })
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.join("\n")}`)
  process.exit(1)
}
console.log("\nall checks passed")
