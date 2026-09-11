import { chromium } from "playwright"
const BASE = "https://canary.smithers.sh"
const ctx = await chromium.launchPersistentContext("/tmp/round3-cards-profile", {
  headless: true,
  viewport: { width: 1280, height: 900 }
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto(BASE, { waitUntil: "domcontentloaded" })
await page.waitForTimeout(4000)
const dump = async (tag: string) => {
  console.log(
    tag,
    await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-flow]")).map((e, i) =>
        `${i}:${e.getAttribute("data-flow")}:${(e.textContent || "").slice(0, 30)}`
      ).join(" | ")
    )
  )
}
await dump("initial:")
await page.locator("[data-flow=\"auth.sign-in\"]").first().click({ force: true })
await page.waitForTimeout(2500)
await dump("after1:")
const btns = page.locator("[data-flow=\"auth.sign-in\"]")
const n = await btns.count()
console.log("count", n)
await btns.nth(n - 1).click({ force: true })
await page.waitForTimeout(8000)
console.log("url", page.url())
if (page.url().includes("github.com")) {
  const authorize = page.locator("button:has-text(\"Authorize\"), input[name=\"authorize\"]")
  if (await authorize.first().isVisible().catch(() => false)) {
    console.log("authorizing")
    await authorize.first().click()
  }
  await page.waitForURL(/canary\.smithers\.sh/, { timeout: 60000 }).catch((e) =>
    console.log("wait", String(e).slice(0, 120))
  )
}
await page.waitForTimeout(8000)
console.log("final url", page.url())
console.log(
  "session:",
  JSON.stringify(await page.evaluate(async () => (await fetch("/api/auth/session")).json().catch(() => null)))
)
console.log((await page.locator("body").innerText()).slice(0, 1500))
await page.screenshot({ path: "/tmp/cards-01-signedin.png", fullPage: true })
await ctx.close()
