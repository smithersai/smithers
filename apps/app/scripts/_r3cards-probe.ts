import { chromium } from "playwright"
const ctx = await chromium.launchPersistentContext("/tmp/round3-cards-profile", {
  headless: true,
  viewport: { width: 1280, height: 900 }
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
const reqs: string[] = []
page.on("response", (r) => {
  const u = r.url()
  if (u.includes("/api/")) reqs.push(`${r.status()} ${r.request().method()} ${u}`)
})
await page.goto("https://canary.smithers.sh", { waitUntil: "domcontentloaded" })
await page.waitForTimeout(6000)
console.log("=== api calls ===")
console.log(reqs.join("\n"))
console.log("=== data-flows on shell ===")
console.log(
  await page.evaluate(() => {
    const el = document.querySelector("[data-flows]")
    return el ? el.getAttribute("data-flows") : "NONE"
  })
)
console.log("=== all data-flow attrs ===")
console.log(
  await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-flow]")).map((e) => e.getAttribute("data-flow")).join(", ")
  )
)
// click sign in
console.log("signin btn count", await page.locator("[data-flow=\"auth.sign-in\"]").count())
await ctx.close()
