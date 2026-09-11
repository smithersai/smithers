import { writeFileSync } from "node:fs"
import { chromium } from "playwright"
const context = await chromium.launchPersistentContext("/tmp/round3-flow-sweep-profile", {
  headless: true,
  viewport: { width: 1280, height: 900 }
})
const page = context.pages()[0] ?? await context.newPage()
await page.goto("https://canary.smithers.sh", { waitUntil: "domcontentloaded" })
await page.locator("[data-flows]").first().waitFor({ timeout: 30_000 })
const before = await page.evaluate(async () => ({
  url: location.href,
  session: await fetch("/api/auth/session").then(async (r) => ({ status: r.status, text: await r.text() })),
  body: document.body.innerText.slice(0, 1500)
}))
const signIn = page.locator("[data-flow=\"auth.sign-in\"]")
if (await signIn.count()) {
  await signIn.last().click({ force: true })
  await page.waitForTimeout(5000)
}
const after = {
  url: page.url(),
  body: (await page.locator("body").innerText()).slice(0, 3000),
  buttons: await page.getByRole("button").allTextContents()
}
writeFileSync("/tmp/round3-flow-auth-probe.json", JSON.stringify({ before, after }, null, 2))
await page.screenshot({ path: "/tmp/round3-flow-auth-probe.png", fullPage: true })
await context.close()
