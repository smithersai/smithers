import { expect, test, type Page } from "@playwright/test"
import { CODING_PLAN } from "../../src/mainview/cards/fixtures/CodingPlan"
import { serve, REPO, RUN_ID } from "./tutorial2-agent_change-fixture"
const plan = { ...CODING_PLAN, changes: [CODING_PLAN.changes[0]!] }
const sha = "e".repeat(40)
const slash = async (page: Page, command: string) => {
  if (!await page.getByTestId("composer-input").isVisible()) await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(command)
  await page.keyboard.press("Enter")
}
// Browser seam fixture; the adjacent route tests verify receipts against real disposable Git repositories.
for (const stale of [false, true]) test(`review before execution; ${stale ? "stale HEAD never completes" : "verified one-commit receipt completes"}`, async ({ page }) => {
  const journal = [
    { sequence: 1, kind: "control.agent.turn-opened", occurredAt: 1000, payload: { seat: "fixture" } },
    { sequence: 2, kind: "control.agent.cell-produced", occurredAt: 1001, payload: { language: "ts", text: "await ctx.call('coding/RunPlan', { plan })" } },
    { sequence: 3, kind: "control.agent.cell-call-started", occurredAt: 1002, payload: { flowName: "coding/RunPlan", input: { plan } } },
    { sequence: 4, kind: "control.agent.cell-call-settled", occurredAt: 1003, payload: { flowName: "coding/RunPlan", outcome: "success" } }
  ]
  const { rpc } = await serve(page, journal)
  await page.route("**/api/tutorial/change/*", route => {
    const verb = new URL(route.request().url()).pathname.split("/").at(-1)
    return route.fulfill({ status: stale && verb === "preflight" ? 409 : 200, contentType: "application/json", body: JSON.stringify(
      verb === "plan" ? plan : verb === "preflight" ? stale ? { message: "HEAD moved; request a new plan." } : { ready: true } :
        { repo: REPO, runId: RUN_ID, base: plan.base.commitId, parent: plan.base.commitId, sha, subject: "Store repository memory", files: ["src/memory.ts", "src/memory.test.ts"] }) })
  })
  // A repository path (/owner/name) opens the repository app alone (AppIsland); the tutorial lives on "/".
  await page.goto("/")
  await expect(page.locator(".guide-shell")).toBeVisible()
  const prerequisites = ["", "issues.opened", "issue.opened", "prs.opened", "file.opened"]
  for (let attempt = 0; attempt < 9; attempt++) {
    const step = Number(await page.locator(".guide-shell").getAttribute("data-stage"))
    if (step === 5) break
    if (step === 0) await page.keyboard.press("ArrowRight")
    else await slash(page, `/onboarding.act signal ${prerequisites[step]}`)
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", String(step + 1))
  }
  await slash(page, `/agent.change ${REPO}`)
  // The plan itself finishes beat 5 (plan.ready); the verified commit finishes beat 6 (commits.made).
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "6")
  const body = page.getByRole("region", { name: "Coding plan" }).last()
  await expect(body).toContainText(plan.changes[0]!.title)
  await expect(body).toContainText(plan.base.commitId)
  await expect(body.getByRole("list", { name: "Planned commits" })).toContainText(plan.changes[0]!.atoms[0]!.message)
  expect(rpc.some(call => call.procedure === "Run")).toBe(false)
  const start = body.getByRole("button", { name: "Start the change" })
  await start.focus(); await page.keyboard.press("Enter")
  if (stale) {
    await expect(page.getByText("HEAD moved; request a new plan.", { exact: false }).first()).toBeVisible()
    expect(rpc.some(call => call.procedure === "Run")).toBe(false)
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "6")
    await expect(page.locator('[data-message-step="6"] .guide-step-done')).toHaveCount(0)
    await expect(page.getByRole("region", { name: "Resulting commit" })).toHaveCount(0)
  } else {
    await expect.poll(() => rpc.some(call => call.procedure === "Run")).toBe(true)
    const strip = page.getByRole("region", { name: "Resulting commit" })
    await expect(strip).toHaveCount(1)
    await expect(strip).toHaveAttribute("data-base", plan.base.commitId)
    await expect(strip).toHaveAttribute("data-commit", sha)
    await expect(strip.getByRole("list", { name: "Changed files" })).toContainText("src/memory.test.ts")
    /* The tutorial's own projection of the run card; the covered workspace is inert. */
    await expect(page.locator("[data-tutorial-cards]").getByTestId(`card-flow-run-${RUN_ID}`)).toHaveAttribute("data-maximized", "false")
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "7")
    await page.reload()
    await expect(page.getByRole("region", { name: "Resulting commit" })).toHaveAttribute("data-commit", sha)
  }
})
