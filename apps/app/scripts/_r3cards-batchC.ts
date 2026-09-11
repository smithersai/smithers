import { lastCard, open, runFlow } from "./_r3cards-lib"
const { ctx, page, consoleErrors } = await open()
const R = "codeplanesmithers/canary-sandbox"
const say = async (cmd: string, kind: string, ms = 8000) => {
  await runFlow(page, cmd, ms)
  const c = await lastCard(page, kind)
  console.log(`\n### ${cmd} -> ${kind}: ${c ? "FOUND" : "MISSING"}`)
  if (c) console.log(JSON.stringify(c).slice(0, 900))
  else console.log("tail:", (await page.locator("body").innerText()).slice(-350).replace(/\s+/g, " "))
}
await say(`/files.list`, "file-list")
await say(`/files.list repo:${R}`, "file-list")
await say(`/files.list ${R} .`, "file-list")
await say(`/files.read ${R} README.md`, "file")
await say(`/issues.view ${R}#47`, "issue")
await say(`/prs.view ${R}#5`, "pr")
await say(`/admin.grant 5 codeplanesmithers`, "grant-confirm")
await say(`/flow.run oneshot`, "run-trace", 12000)
console.log(
  "\n=== kinds ===",
  await page.evaluate(() =>
    Array.from(document.querySelectorAll(".smithers-card")).map((e) => e.getAttribute("data-kind")).join(", ")
  )
)
console.log("errors:", consoleErrors.slice(0, 8))
await ctx.close()
