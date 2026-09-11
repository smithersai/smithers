import { lastCard, open, runFlow } from "./_r3cards-lib"
const { ctx, page, consoleErrors } = await open()
const R = "codeplanesmithers/canary-sandbox"
const FLOWS: Array<[string, string]> = [
  [`/env.view ${R}`, "env"],
  [`/branches.list ${R}`, "branches"],
  [`/files.list ${R}`, "file-list"],
  [`/issues.list ${R}`, "issue-list"],
  [`/prs.list ${R}`, "pr-list"],
  [`/repos.import ${R}`, "repo-import"],
  [`/flow.repo.choose ${R}`, "workflow-repo"],
  [`/browser https://example.com`, "browser"],
  [`/admin.grant codeplanesmithers 5`, "grant-confirm"]
]
for (const [cmd, kind] of FLOWS) {
  await runFlow(page, cmd, 8000)
  const c = await lastCard(page, kind)
  console.log(`\n### ${cmd} -> ${kind}: ${c ? "FOUND" : "MISSING"}`)
  if (c) console.log(JSON.stringify(c))
  else console.log("tail:", (await page.locator("body").innerText()).slice(-400).replace(/\s+/g, " "))
}
console.log(
  "\n=== kinds ===",
  await page.evaluate(() =>
    Array.from(document.querySelectorAll(".smithers-card")).map((e) => e.getAttribute("data-kind")).join(", ")
  )
)
console.log("errors:", consoleErrors.slice(0, 8))
await ctx.close()
