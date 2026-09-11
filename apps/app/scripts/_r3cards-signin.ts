import { chromium } from "playwright"
const BASE = "https://canary.smithers.sh"
const ctx = await chromium.launchPersistentContext("/tmp/round3-cards-profile", {
  headless: true,
  viewport: { width: 1280, height: 900 }
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto(BASE, { waitUntil: "domcontentloaded" })
await page.waitForTimeout(4000)
let sess = await page.evaluate(async () => (await fetch("/api/auth/session")).json().catch(() => null))
console.log("before:", JSON.stringify(sess))
if (!sess || typeof (sess as any).login !== "string") {
  const signIn = page.locator("[data-flow=\"auth.sign-in\"]").first()
  console.log("sign-in affordance count:", await page.locator("[data-flow=\"auth.sign-in\"]").count())
  await signIn.click({ force: true })
  await page.waitForTimeout(5000)
  console.log("url after click:", page.url())
  const authorize = page.locator("button:has-text(\"Authorize\")")
  if (await authorize.isVisible().catch(() => false)) {
    console.log("authorizing")
    await authorize.click()
  }
  await page.waitForURL(/canary\.smithers\.sh/, { timeout: 45_000 }).catch((e) =>
    console.log("waitURL:", String(e).slice(0, 150))
  )
  await page.waitForTimeout(6000)
  sess = await page.evaluate(async () => (await fetch("/api/auth/session")).json().catch(() => null))
  console.log("after:", JSON.stringify(sess))
}
console.log("url:", page.url())
console.log("=== body ===")
console.log((await page.locator("body").innerText()).slice(0, 2500))
await page.screenshot({ path: "/tmp/cards-01-signedin.png", fullPage: true })
await ctx.close()
