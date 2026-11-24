// Real queue/server/browser regressions for attachment selection and old-line review notes.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { startServer } from "../serve.mjs"
import { hasHomeCounts } from "../screenshot-checks.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const { default: playwright } = await import(pathToFileURL(join(here, "../../mvp/node_modules/@playwright/test/index.mjs")).href)
const { expect } = playwright
let browser
before(async () => { browser = await playwright.chromium.launch() })
after(async () => { await browser?.close() })

async function openItem(t, item) {
  const dir = mkdtempSync(join(tmpdir(), "queue-review-"))
  const repo = join(dir, "repo")
  const queueDir = join(dir, "queue")
  cpSync(join(here, "fixtures/repo"), repo, { recursive: true })
  mkdirSync(queueDir)
  writeFileSync(join(repo, "source.txt"), "# Source\n")
  writeFileSync(join(repo, "README.md"), "# Readme\n")
  writeFileSync(join(queueDir, "queue.json"), JSON.stringify({
    version: 1,
    items: [{ id: "review", title: "Review", priority: 1, ...item }],
  }))
  writeFileSync(join(queueDir, "answers.jsonl"), "")
  const server = startServer({ port: 0, repo, queueDir, site: repo })
  const errors = []
  let page
  t.after(async () => {
    await page?.context().close()
    await server.close()
    rmSync(dir, { recursive: true, force: true })
    assert.deepEqual(errors, [], "no browser errors")
  })
  const base = await server.ready
  page = await browser.newPage({ reducedMotion: "reduce" })
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`${base}/queue`)
  await page.locator('.q-card[data-id="review"]').waitFor()
  return page
}

const attachments = [
  { label: "Source code", path: "src/shape-stream.ts" },
  { label: "Styles", path: "src/shape-stream.css" },
]

test("attachment buttons select their own file and continue keyboard cycling", async (t) => {
  for (const media of [
    { type: "md", path: "README.md" },
    { type: "markdown", path: "source.txt" },
    { path: "README.md" },
    null,
  ]) {
    for (const count of [1, 2]) {
      await t.test(`${media ? JSON.stringify(media) : "no Markdown source"} with ${count} attachments`, async (t) => {
        const links = attachments.slice(0, count)
        const page = await openItem(t, { kind: "design", ...(media ? { media: [media] } : {}), links })
        if (media) await page.locator(".q-md").waitFor()
        const viewer = page.locator(".q-viewer")
        const list = [...(media ? [{ label: "Source", path: media.path }] : []), ...links]
        const opened = async (index) => {
          await expect(viewer.locator(".q-code.loading")).toHaveCount(0)
          await expect(viewer.locator(".q-path")).toHaveText(`${list[index].label} · ${list[index].path}`, { timeout: 1500 })
          await expect(viewer.locator(".q-line")).not.toHaveCount(0)
          if (list.length > 1) await expect(viewer.locator(".q-range")).toContainText(`${index + 1} / ${list.length}`)
        }
        for (let index = 0; index < links.length; index++) {
          await page.locator(`[data-link="${index}"]`).click()
          await opened(index + (media ? 1 : 0))
          await page.keyboard.press("o")
          await opened((index + (media ? 1 : 0) + 1) % list.length)
          await page.keyboard.press("Escape")
          await expect(viewer).toBeHidden()
        }
      })
    }
  }
})

const lines = Array.from({ length: 50 }, (_, index) => `const line${index + 1} = ${index + 1}`)
const single = (line, note) => [line, line, note]

test("code comparisons retain pinned old lines and three lines of context", async (t) => {
  const changed = [...lines]
  changed[39] = "const line40 = 400"
  const shifted = ["// inserted", ...lines]
  for (const scenario of [
    { name: "unchanged note far before a change", now: changed, pins: [single(2, "keep this guard")] },
    { name: "multiple distant notes and a range", now: changed, pins: [single(1, "first line"), [12, 14, "keep this range"], single(50, "last line")] },
    { name: "identical files with a note", now: lines, pins: [single(25, "still needs review")] },
    { name: "different slice offsets and an insertion before the note", now: shifted, from: 10, afterFrom: 11, pins: [[20, 22, "use old line numbers"]] },
    { name: "insertion shifts the new line number", now: shifted, pins: [single(25, "keep the old guard")] },
    { name: "changed old line with a note", now: changed, pins: [single(40, "the changed line")] },
    { name: "empty note still pins the line", now: changed, pins: [single(8, "")] },
    { name: "unannotated comparisons keep folding", now: changed, pins: [] },
  ]) {
    await t.test(scenario.name, async (t) => {
      const from = scenario.from ?? 1
      const afterFrom = scenario.afterFrom ?? from
      const note = scenario.pins.map(([start, end, text]) => `L${start}${end === start ? "" : `-L${end}`}: ${text}`).join("\n")
      const page = await openItem(t, {
        kind: "verify",
        before: { media: { type: "code", path: "before.ts", text: lines.join("\n"), from }, note },
        after: { media: { type: "code", path: "after.ts", text: scenario.now.join("\n"), from: afterFrom } },
      })
      await page.locator(".q-diff:not(.loading) .q-line").first().waitFor()
      const rows = await page.locator(".q-diff .q-line:not(.q-fold):not(.q-pin-row)").evaluateAll((rows) => rows.map((row) => ({
        old: Number(row.querySelector(".q-ln").textContent),
        now: Number(row.querySelectorAll(".q-ln")[1].textContent),
        text: row.querySelector(".q-lc").textContent,
        pinned: row.classList.contains("pinned"),
        note: row.nextElementSibling?.classList.contains("q-pin-row") ? row.nextElementSibling.textContent : null,
      })))
      for (const [start, end, text] of scenario.pins) {
        for (let line = start; line <= end; line++) {
          const row = rows.find((row) => row.old === line)
          assert.ok(row?.pinned, `old line ${line} stays visible and pinned`)
          assert.equal(row.text, lines[line - 1])
          if (text) assert.equal(row.note.trim(), `You said: ${text}`)
          if (scenario.now === shifted) assert.equal(row.now, line + 1)
          for (let nearby = Math.max(from, line - 3); nearby <= Math.min(lines.length, line + 3); nearby++)
            assert.ok(rows.some((row) => row.old === nearby), `old line ${nearby} provides context for L${line}`)
        }
      }
      const expectedPins = scenario.pins.reduce((count, [start, end]) => count + end - start + 1, 0)
      assert.equal(rows.filter((row) => row.pinned).length, expectedPins)
      await expect(page.locator(".q-fold")).not.toHaveCount(0)
      const counts = scenario.now === changed ? "+1 −1" : scenario.now === shifted && from === 1 ? "+1 −0" : "+0 −0"
      await expect(page.locator(".q-diff-count")).toHaveText(counts)
    })
  }
})

test("the built home renders three counts and the screenshot check rejects their removal", async (t) => {
  const site = mkdtempSync(join(tmpdir(), "maintainer-home-"))
  t.after(() => rmSync(site, { recursive: true, force: true }))
  const built = spawnSync(process.execPath, [join(here, "../build.mjs")], {
    encoding: "utf8",
    env: { ...process.env, MAINTAINER_SITE_OUT: site, MAINTAINER_SITE_GIFS: join(here, "fixtures/repo/gifs") },
  })
  assert.equal(built.status, 0, built.stderr)
  const page = await browser.newPage()
  t.after(() => page.close())
  await page.goto(pathToFileURL(join(site, "index.html")).href)
  await page.waitForSelector(".stat-n")
  assert.equal(hasHomeCounts(await page.locator(".stat-n").allTextContents()), true)
  await page.locator(".stat-n").evaluateAll((nodes) => nodes.forEach((node) => node.remove()))
  assert.equal(hasHomeCounts(await page.locator(".stat-n").allTextContents()), false)
})

test("a signed-in reviewer can approve a scripted design with relative assets and an opaque origin", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "queue-auth-browser-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const item = { id: "browser-review", kind: "design", title: "Browser review", media: [{ type: "html", path: "files/design.html" }] }
  writeFileSync(join(dir, "queue.json"), JSON.stringify({ items: [item] }))
  writeFileSync(join(dir, "index.html"), "<title>Site</title>")
  mkdirSync(join(dir, "files"))
  writeFileSync(join(dir, "files", "design.css"), "img { width: 31px }")
  writeFileSync(join(dir, "files", "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="9"/>')
  writeFileSync(join(dir, "files", "design.html"), [
    '<title>Design</title><link rel="stylesheet" href="design.css"><img src="icon.svg">',
    "<script>document.title='executed'</script>",
  ].join(""))
  const server = startServer({ port: 0, repo: dir, queueDir: dir, site: dir, writeToken: "browser-fixture" })
  t.after(() => server.close())
  const base = await server.ready
  const page = await browser.newPage({ httpCredentials: { username: "maintainer", password: "browser-fixture" } })
  t.after(() => page.context().close())
  await page.goto(base + "/queue")
  await page.locator('.q-card[data-id="browser-review"]').waitFor()
  const frame = page.frameLocator("iframe.q-frame")
  const image = frame.locator("img")
  await expect(image).toHaveCSS("width", "31px")
  await expect(image).toHaveJSProperty("naturalWidth", 11)
  assert.deepEqual(await image.evaluate(async () => ({
    title: document.title, origin: self.origin,
    queueReadable: await fetch("/api/queue").then((r) => r.ok, () => false),
  })), { title: "executed", origin: "null", queueReadable: false })
  const saved = page.waitForResponse((res) => res.url().endsWith("/api/answer"), { timeout: 5000 })
  await page.keyboard.press("a")
  assert.equal((await saved).status(), 200)
  const receipt = JSON.parse(readFileSync(join(dir, "answers.jsonl"), "utf8"))
  assert.equal(receipt.action, "approve")
  assert.match(receipt.digest, /^[0-9a-f]{64}$/)
  await page.goto(base + "/files/design.html")
  assert.equal(await page.title(), "executed")
  assert.equal(await page.evaluate(() => window.origin), "null")
})

test("undo in a stale tab keeps the newer approval, including after a reload", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "queue-undo-"))
  const publish = (revision) => writeFileSync(join(dir, "queue.json"), JSON.stringify({
    items: [{ id: "decision", kind: "design", title: "Design", revision }],
  }))
  publish("v1")
  const app = startServer({ port: 0, repo: dir, queueDir: dir, writeToken: "fixture" })
  const context = await browser.newContext({ httpCredentials: { username: "maintainer", password: "fixture" } })
  t.after(async () => { await context.close(); await app.close(); rmSync(dir, { recursive: true, force: true }) })
  const base = await app.ready
  const answer = async (page, key) => {
    const response = page.waitForResponse((r) => r.url() === base + "/api/answer", { timeout: 5000 })
    await page.keyboard.press(key)
    return response
  }
  const approve = async () => {
    const page = await context.newPage()
    await page.goto(base + "/queue")
    await page.locator('.q-card[data-id="decision"]').waitFor()
    const response = await answer(page, "a")
    assert.equal(response.status(), 200)
    return { page, id: (await response.json()).answer.answerId }
  }
  const first = await approve()
  publish("v2")
  const second = await approve()
  const stale = await answer(first.page, "u")
  assert.equal(stale.request().postDataJSON().answerId, first.id)
  assert.equal(stale.status(), 409)
  assert.equal((await (await fetch(base + "/api/queue")).json()).last.answerId, second.id)
  await second.page.reload()
  await second.page.locator(".q-empty").waitFor()
  const undo = await answer(second.page, "u")
  assert.equal(undo.request().postDataJSON().answerId, second.id)
  assert.equal(undo.status(), 200)
  await second.page.locator('.q-card[data-id="decision"]').waitFor()
})
