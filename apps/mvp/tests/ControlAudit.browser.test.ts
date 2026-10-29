import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { wholeText } from "../e2e/console"
import { appliedRecord } from "../e2e/layout-sync"
import { createServer } from "node:http"
import { trackCloneOffers } from "../e2e/clone-offers"
import { chromium, webkit } from "playwright"
import { expect, test } from "vitest"
import { auditControls, CONTROL_SELECTOR } from "../e2e/control-audit"

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: a queued list update cannot shift the controls under the audit`, async () => {
    const browser = await engine.launch()
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.setContent(`<style>body{margin:0}a,button{display:block;width:96px;height:32px;margin:8px}.skip{clip-path:inset(50%)}.skip:focus{clip-path:none}</style>
        <a class="skip" href="#body" onfocus="setTimeout(()=>document.querySelector('#last').remove(),0)">Skip</a>
        <button id="body">First</button><button id="last">Last</button>`)
      const receipt = await auditControls(page.locator(CONTROL_SELECTOR))
      expect(receipt).toEqual({ selected: 3, checked: 3, findings: [] })
      await expect.poll(() => page.locator("#last").count()).toBe(0)
    } finally { await browser.close() }
  })

  for (const width of [390, 768, 1280]) test(`${engine.name()} ${width}: every control of a populated list is audited`, async () => {
    const browser = await engine.launch()
    const page = await browser.newPage({ viewport: { width, height: 844 } })
    try {
      await page.setContent(`<style>body{margin:0}button{display:block;width:96px;height:32px;margin:8px}</style>${Array.from({ length: 1100 }, (_, index) => `<button>Issue ${index}</button>`).join("")}`)
      expect(await auditControls(page.locator(CONTROL_SELECTOR))).toEqual({ selected: 1100, checked: 1100, findings: [] })
    } finally { await browser.close() }
  })

  test(`${engine.name()}: undersized, covered, clipped and offscreen controls remain findings`, async () => {
    const browser = await engine.launch()
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    try {
      await page.setContent(`<style>body{margin:0}button{display:block;width:96px;height:32px;margin:8px}button[hidden]{display:none}.cover{position:fixed;inset:0;z-index:2}.small{width:12px;height:12px}.outside{position:fixed;left:-20px;top:100px}section{width:32px;overflow:hidden}</style>
        <button hidden>Hidden</button><button class="small">Small</button><button class="outside">Outside</button><section><button>Clipped</button></section><div class="cover"></div>`)
      const receipt = await auditControls(page.locator(CONTROL_SELECTOR))
      expect(receipt.selected).toBe(4)
      expect(receipt.checked).toBe(3)
      for (const problem of ["tap target", "outside viewport", "covered by", "clipped by"]) expect(receipt.findings.some(finding => finding.problem.startsWith(problem))).toBe(true)
    } finally { await browser.close() }
  })
}

for (const engine of [chromium, webkit]) test(`${engine.name()}: Clone history survives reload and later navigation`, async () => {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html")
    response.end(`<header aria-label="Repository">${request.url === "/clone" ? "<button>Clone</button>" : ""}</header><a href="/clone">Open repository</a><script>console.info("unrelated")</script>`)
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`
  const browser = await engine.launch()
  const page = await browser.newPage()
  try {
    const offers = await trackCloneOffers(page)
    await page.goto(origin)
    expect(offers()).toBe(0)
    await page.getByRole("link", { name: "Open repository" }).click()
    await expect.poll(offers).toBe(1)
    await page.reload()
    await expect.poll(offers).toBe(2)
    await page.goto(origin)
    expect(offers()).toBe(2)
    await page.getByRole("link", { name: "Open repository" }).click()
    await expect.poll(offers).toBe(3)
  } finally {
    await browser.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

for (const engine of [chromium, webkit]) test(`${engine.name()}: the real Effect logger reaches the applied audit through full console arguments`, async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("./fixtures/applied-log.ts", import.meta.url))], bundle: true, write: false, platform: "browser", format: "esm" })
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/fixture.js" ? "text/javascript" : "text/html")
    response.end(request.url === "/fixture.js" ? bundle.outputFiles[0]!.text : '<main>Issues</main><script type="module" src="/fixture.js"></script>')
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`
  const browser = await engine.launch()
  const page = await browser.newPage()
  const records: Array<ReturnType<typeof appliedRecord>> = []
  const previews: Array<ReturnType<typeof appliedRecord>> = []
  const pending: Array<Promise<void>> = []
  page.on("console", message => {
    if (!message.text().includes("shape.initial.applied")) return
    previews.push(appliedRecord(message.text()))
    pending.push(wholeText(message).then(text => { records.push(appliedRecord(text)) }))
  })
  try {
    await page.goto(origin)
    await expect.poll(() => records).toEqual([{ source: "todos", repository: "smithersai/smithers" }])
    expect(previews).toEqual([undefined])
    await Promise.all(pending)
  } finally {
    await browser.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
