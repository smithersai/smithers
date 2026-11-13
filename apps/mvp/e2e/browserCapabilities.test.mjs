import { createServer } from "node:http"
import { once } from "node:events"
import { chromium, expect, webkit } from "@playwright/test"
import { before, after, test } from "node:test"
import assert from "node:assert/strict"
import { clipboardPermissions, chromiumNetwork, readClipboard } from "./browserCapabilities.ts"

// A real HTTP page exercises the browsers' native clipboard and connectivity APIs.
const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" })
  response.end([
    '<input aria-label="Focus marker"><button>Copy</button><script>',
    'document.querySelector("button").onclick = async () => {',
    'await navigator.clipboard.writeText(new URL(location.href).searchParams.get("text"));',
    'document.querySelector("button").textContent = "Copied";',
    "};</script>",
  ].join("\n"))
})
let origin
before(async () => {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  origin = "http://127.0.0.1:" + server.address().port
})
after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))

for (const browser of [chromium, webkit]) {
  test(browser.name() + " grants clipboard permissions and reads an actual Copy action", async () => {
    const launched = await browser.launch({ headless: true })
    const context = await launched.newContext()
    try {
      const page = await context.newPage()
      await context.grantPermissions(clipboardPermissions(browser.name()))
      const text = "actual-copy-" + browser.name() + "-" + crypto.randomUUID()
      await page.goto(origin + "?text=" + encodeURIComponent(text))
      await page.getByRole("button", { name: "Copy", exact: true }).click()
      await expect.poll(() => page.getByRole("button").textContent()).toBe("Copied")
      await page.getByRole("textbox", { name: "Focus marker" }).focus()
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))
      assert.equal(await readClipboard(browser.name(), page), text)
      assert.equal(await readClipboard(browser.name(), page), text)
      assert.equal(await page.locator("textarea").count(), 0, "the paste target is removed")
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), focused, "clipboard checks restore focus")
    } finally { await launched.close() }
  })

  test(browser.name() + " uses CDP only when supported and retains real connectivity", async () => {
    const launched = await browser.launch({ headless: true })
    const context = await launched.newContext()
    try {
      const page = await context.newPage()
      await page.goto(origin)
      const network = await chromiumNetwork(browser.name(), page)
      try {
        assert.equal(network === undefined, browser === webkit)
        if (network !== undefined) {
          await network.send("Network.overrideNetworkState", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
          assert.equal(await page.evaluate(() => navigator.onLine), false)
          await network.send("Network.overrideNetworkState", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
          assert.equal(await page.evaluate(() => navigator.onLine), true)
        }
        assert.equal(await page.evaluate(() => fetch(location.href).then(response => response.ok)), true)
      } finally { await network?.detach() }
    } finally { await launched.close() }
  })
}
