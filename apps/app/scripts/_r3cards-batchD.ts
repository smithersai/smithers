import { lastCard, open, runFlow } from "./_r3cards-lib"
const { ctx, page, consoleErrors } = await open()
const R = "codeplanesmithers/canary-sandbox"
const say = async (cmd: string, kind: string, ms = 9000) => {
  await runFlow(page, cmd, ms)
  const c = await lastCard(page, kind)
  console.log(`\n### ${cmd} -> ${kind}: ${c ? "FOUND" : "MISSING"}`)
  if (c) console.log(JSON.stringify(c))
  else console.log("tail:", (await page.locator("body").innerText()).slice(-320).replace(/\s+/g, " "))
}
await say(`/files.list . ${R}`, "file-list")
await say(`/files.read README.md ${R}`, "file")
await say(`/issues.view 47 ${R}`, "issue")
await say(`/prs.view 5 ${R}`, "pr")
console.log(
  "\n=== kinds ===",
  await page.evaluate(() =>
    Array.from(document.querySelectorAll(".smithers-card")).map((e) => e.getAttribute("data-kind")).join(", ")
  )
)
console.log("errors:", consoleErrors.slice(0, 8))
await ctx.close()
