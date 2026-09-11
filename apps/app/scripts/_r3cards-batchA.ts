import { lastCard, open, runFlow } from "./_r3cards-lib"
const { ctx, page, consoleErrors } = await open()
const FLOWS: Array<[string, string]> = [
  ["/billing.balance", "balance"],
  ["/admin.health", "admin-health"],
  ["/admin.requests", "request-queue"],
  ["/connect", "connect"],
  ["/world", "world"],
  ["/theme", "theme-picker"],
  ["/notifications.list", "notifications"],
  ["/env.view", "env"],
  ["/secrets.list", "secrets"],
  ["/branches.list", "branches"],
  ["/files.list", "file-list"],
  ["/issues.list", "issue-list"],
  ["/prs.list", "pr-list"],
  ["/repos.import", "repo-import"],
  ["/flow.repo.choose", "workflow-repo"],
  ["/repos.watch", "repo-chooser"]
]
for (const [cmd, kind] of FLOWS) {
  await runFlow(page, cmd, 7000)
  const c = await lastCard(page, kind)
  console.log(`\n### ${cmd} -> ${kind}: ${c ? "FOUND" : "MISSING"}`)
  if (c) console.log(JSON.stringify(c))
  else console.log("tail:", (await page.locator("body").innerText()).slice(-500).replace(/\s+/g, " "))
}
console.log("\n=== all card kinds in transcript ===")
console.log(
  await page.evaluate(() =>
    Array.from(document.querySelectorAll(".smithers-card")).map((e) =>
      `${e.getAttribute("data-kind")}:${e.getAttribute("data-status")}`
    ).join(", ")
  )
)
console.log("errors:", consoleErrors.slice(0, 8))
await page.screenshot({ path: "/tmp/cards-batchA.png", fullPage: true })
await ctx.close()
