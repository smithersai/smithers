// Drives https://app.opencode.ai in headless chromium against the proxy on 127.0.0.1:4096.
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"
const require = createRequire("/Users/williamcory/smithers/apps/app/package.json")
const { chromium } = require("playwright")

const DIR = path.dirname(new URL(import.meta.url).pathname)
const RUN = process.env.RUN ?? "a"
const SHOTS = path.join(DIR, "shots", RUN)
const APP = process.env.APP_URL ?? "https://app.opencode.ai"
fs.mkdirSync(SHOTS, { recursive: true })
const steps = []
async function marker(step, note) {
  await fetch("http://127.0.0.1:4096/__marker", { method: "POST", body: JSON.stringify({ step, note }) })
  steps.push({ step, note, at: new Date().toISOString() })
  console.log(`[${new Date().toISOString()}] step ${step}: ${note}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ headless: true, args: ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults"] })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await context.newPage()
const consoleLog = fs.createWriteStream(path.join(SHOTS, "console.log"), { flags: "a" })
page.on("console", (m) => consoleLog.write(`[${m.type()}] ${m.text()}\n`))
page.on("pageerror", (e) => consoleLog.write(`[pageerror] ${e.message}\n`))
page.on("requestfailed", (r) => consoleLog.write(`[requestfailed] ${r.method()} ${r.url()} ${r.failure()?.errorText}\n`))

async function snap(name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false })
  try {
    const tree = await page.locator("body").ariaSnapshot()
    fs.writeFileSync(path.join(SHOTS, `${name}.aria.txt`), tree)
  } catch (e) {
    fs.writeFileSync(path.join(SHOTS, `${name}.aria.txt`), "aria failed: " + e.message)
  }
}

async function dismissDialogs() {
  for (let i = 0; i < 3; i++) {
    const dialog = page.getByRole("dialog")
    if ((await dialog.count()) === 0) return
    const txt = (await dialog.first().innerText().catch(() => "")).slice(0, 200)
    console.log("dialog present:", JSON.stringify(txt))
    await page.keyboard.press("Escape")
    await sleep(500)
  }
}

function editor() {
  return page.locator('[data-component="prompt-input"][contenteditable="true"]').first()
}

async function waitIdle(timeoutMs) {
  // Wait until the Stop button disappears (run finished) and a settle period passes.
  const start = Date.now()
  await sleep(1500)
  while (Date.now() - start < timeoutMs) {
    const stop = page.getByRole("button", { name: "Stop", exact: true })
    const busy = (await stop.count()) > 0 && (await stop.first().isVisible().catch(() => false))
    if (!busy) {
      await sleep(1500)
      const again = (await stop.count()) > 0 && (await stop.first().isVisible().catch(() => false))
      if (!again) return true
    }
    await sleep(500)
  }
  return false
}

async function pickModelIfNeeded() {
  const sel = page.getByRole("button", { name: /select model/i })
  if ((await sel.count()) === 0 || !(await sel.first().isVisible().catch(() => false))) return
  console.log("no default model; opening the model picker")
  await sel.first().click()
  await sleep(1500)
  await snap("model-picker")
  const opt = page.getByRole("option", { name: /big pickle/i }).or(page.getByRole("menuitem", { name: /big pickle/i })).or(page.getByText(/^Big Pickle$/i))
  if ((await opt.count()) > 0) {
    await opt.first().click()
    console.log("picked Big Pickle")
  } else {
    console.log("Big Pickle option not found; pressing Escape")
    await page.keyboard.press("Escape")
  }
  await sleep(1000)
}

async function submit(text) {
  const ed = editor()
  await ed.waitFor({ state: "visible", timeout: 30000 })
  await pickModelIfNeeded()
  await ed.click()
  await page.keyboard.type(text, { delay: 5 })
  await sleep(300)
  await page.keyboard.press("Enter")
  await sleep(1500)
  const remaining = (await ed.innerText().catch(() => "")).trim()
  if (remaining.length > 0) {
    console.log("Enter did not submit; clicking Send")
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await sleep(1500)
  }
  const still = (await editor().innerText().catch(() => "")).trim()
  console.log("submitted:", JSON.stringify(text), "editor now:", JSON.stringify(still.slice(0, 40)), "url:", page.url())
}

async function sessionUrl() {
  return page.url()
}

try {
  await marker("a", "open app and wait for connection")
  await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 60000 })
  await sleep(6000)
  await dismissDialogs()
  await sleep(1000)
  await snap("a-connected")
  console.log("url after load:", page.url())

  await marker("b", "create a new session")
  const DIRECTORY = "/private/tmp/claude-501/-Users-williamcory-smithers/3312bf7f-d097-4b8e-b5d9-013b3b8d4463/scratchpad/trace/trace-repo"
  const b64 = Buffer.from(DIRECTORY, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
  // The hosted app opens with no project selected. Try the Add project picker first, then open the project by its route.
  const add = page.getByRole("button", { name: "Add project" }).first()
  if ((await add.count()) > 0) {
    await add.click()
    await sleep(1500)
    await snap("b-add-project-dialog")
    const box = page.getByRole("dialog").getByRole("textbox").last()
    if ((await box.count()) > 0) {
      await box.fill(DIRECTORY)
      await sleep(1500)
      await snap("b-add-project-typed")
      // Enter would pick the first fuzzy match (a foreign directory). Close the picker and use the app's own project route.
      await page.keyboard.press("Escape")
      await sleep(800)
      console.log("url after picker:", page.url())
    }
  }
  if (!page.url().includes(b64)) {
    console.log("picker did not open the project; navigating to the project route")
    await page.goto(`${APP}/${b64}`, { waitUntil: "domcontentloaded", timeout: 60000 })
    await sleep(5000)
    await dismissDialogs()
    await snap("b-project-route")
    console.log("url after project route:", page.url())
  }
  const newBtn = page.getByRole("button", { name: /new session/i })
  if (page.url().includes("/new-session")) {
    console.log("project route already opened a new-session draft; not clicking New session again")
  } else if ((await newBtn.count()) > 0) {
    await newBtn.first().click()
    console.log("clicked New session button")
  } else {
    console.log("no New session button")
  }
  await sleep(2500)
  await snap("b-new-session")
  console.log("url after new session:", page.url())

  await marker("c", "prompt: read package.json")
  await submit("Read package.json and tell me the name field.")
  await sleep(2000)
  await snap("c-sent")
  const ok = await waitIdle(180000)
  console.log("c idle:", ok, "url:", page.url())
  await snap("c-answered")

  await marker("d", "prompt: run ls -la, permission Once")
  await submit("Run `ls -la` and summarize.")
  const once = page.getByRole("button", { name: /allow once|^once$/i })
  let clicked = false
  const t0 = Date.now()
  while (Date.now() - t0 < 120000) {
    if ((await once.count()) > 0 && (await once.first().isVisible().catch(() => false))) {
      await snap("d-permission-card")
      await once.first().click()
      clicked = true
      console.log("clicked Allow once after", Date.now() - t0, "ms")
      break
    }
    await sleep(300)
  }
  if (!clicked) console.log("permission card never appeared")
  const okd = await waitIdle(180000)
  console.log("d idle:", okd)
  await snap("d-answered")

  await marker("e", "prompt: say done")
  await submit("Say done.")
  const oke = await waitIdle(120000)
  console.log("e idle:", oke)
  await snap("e-answered")

  await marker("f", "reload and confirm history renders")
  const before = page.url()
  await page.reload({ waitUntil: "domcontentloaded" })
  await sleep(6000)
  await dismissDialogs()
  await snap("f-reloaded")
  const body = await page.locator("body").innerText()
  console.log("f url:", page.url(), "same:", page.url() === before, "history has package.json prompt:", body.includes("Read package.json"), "has done:", /done/i.test(body))

  await marker("g", "rename via the UI")
  const heading = page.locator("h1, h2, [data-slot='session-title']").filter({ hasText: /.+/ }).first()
  let renamed = false
  try {
    const headings = page.getByRole("heading")
    const n = await headings.count()
    console.log("headings:", n)
    for (let i = 0; i < n; i++) {
      const h = headings.nth(i)
      const t = (await h.innerText().catch(() => "")).trim()
      console.log(" heading", i, JSON.stringify(t))
    }
    const target = headings.first()
    await target.click({ timeout: 5000 })
    await sleep(500)
    const input = page.locator("input:focus, textarea:focus, [contenteditable='true']:focus").first()
    if ((await input.count()) > 0) {
      await snap("g-rename-editing")
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
      await page.keyboard.type("Trace renamed session")
      await page.keyboard.press("Enter")
      renamed = true
    }
  } catch (e) {
    console.log("rename attempt failed:", e.message)
  }
  await sleep(2000)
  await snap("g-renamed")
  console.log("renamed:", renamed)

  await marker("h", "open the sidebar session list")
  const sessionUrlBefore = page.url()
  const toggle = page.getByRole("button", { name: /toggle sidebar|toggle menu/i })
  console.log("sidebar toggles:", await toggle.count())
  if ((await toggle.count()) > 0) {
    await toggle.first().click()
    await sleep(1500)
    await snap("h-sidebar-open")
  } else {
    // The hosted layout has no sidebar toggle at this viewport; the session list lives behind the Home button.
    const home = page.getByRole("button", { name: "Home", exact: true })
    if ((await home.count()) > 0) {
      await home.first().click()
      await sleep(2500)
      await snap("h-home-session-list")
      const body = await page.locator("body").innerText()
      console.log("home lists renamed session:", body.includes("Trace renamed session"))
      const row = page.getByText("Trace renamed session", { exact: true }).first()
      if ((await row.count()) > 0) {
        await row.click()
        await sleep(2500)
        await snap("h-back-to-session")
      }
    }
    const review = page.getByRole("button", { name: "Toggle review", exact: true })
    if ((await review.count()) > 0) {
      await marker("h2", "toggle review panel (extra)")
      await review.first().click()
      await sleep(2500)
      await snap("h2-review-open")
    }
  }
  await marker("z", "end of drive")
} catch (e) {
  console.log("DRIVE ERROR:", e.stack)
  await snap("error").catch(() => {})
} finally {
  fs.writeFileSync(path.join(SHOTS, "steps.json"), JSON.stringify(steps, null, 2))
  await browser.close()
}
