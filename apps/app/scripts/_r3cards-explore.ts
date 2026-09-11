import { open } from "./_r3cards-lib"
const { ctx, page, consoleErrors } = await open()
const box = page.locator("textarea").first()
console.log("textarea placeholder:", await box.getAttribute("placeholder"))
await box.click({ force: true })
await box.fill("/flow.list")
await page.waitForTimeout(800)
console.log("--- after typing, body tail ---")
console.log((await page.locator("body").innerText()).slice(-1200))
await box.press("Enter")
await page.waitForTimeout(8000)
console.log("--- after enter ---")
console.log((await page.locator("body").innerText()).slice(-2500))
console.log(
  "cards:",
  await page.evaluate(() =>
    Array.from(document.querySelectorAll(".smithers-card")).map((e) => e.getAttribute("data-kind")).join(",")
  )
)
console.log("errors", consoleErrors.slice(0, 5))
await page.screenshot({ path: "/tmp/cards-02-flowlist.png", fullPage: true })
await ctx.close()
