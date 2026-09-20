import { expect, test, type Page } from "@playwright/test"
import { GRAPH_REPO, AUTHORING_READ, AUTHORING_VALIDATE } from "./workspace"

const command = async (page: Page, text: string) => {
  const composer = page.getByTestId("composer-input")
  if (!await composer.isVisible()) await page.locator('[data-flow="chat.open"]').first().click()
  await composer.fill(text)
  await composer.press("Enter")
}

// The author is scripted. Its source writes, copy-back, journal, compiler,
// control approvals, execution and browser are real; no provider is involved.
test("authors, edits, replans and runs the written source from chat", async ({ page }) => {
  await page.goto("/")
  const request = `/flow.create Build a flow ${GRAPH_REPO}`
  await command(page, request)
  const author = page.locator('.smithers-card[data-kind="run-trace"]').first()
  await expect(author).toContainText("Creating a flow")
  const plan = page.locator('.smithers-card[data-kind="flow-plan"]')
  const read = plan.locator(`.flow-graph-node[data-node="${AUTHORING_READ}"]`)
  const validate = plan.locator(`.flow-graph-node[data-node="${AUTHORING_VALIDATE}"]`)
  await expect(read).toBeVisible()
  await expect(validate).toHaveCount(0)
  const planId = await plan.getAttribute("data-testid")

  // Repeating the command neither launches another author nor blocks chat.
  await command(page, request)
  await expect(page.locator('.smithers-card[data-kind="run-trace"]')).toHaveCount(1)
  await command(page, "hello")
  await expect(page.getByTestId("composer-input")).toBeEnabled()
  await expect(page.getByText("Local chat accepts /flow.* commands.", { exact: true })).toBeVisible()
  await expect(page.getByTestId("composer-stop")).not.toBeVisible()
  await expect(page.locator("body")).not.toContainText("stub:")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("composer-overlay")).not.toBeVisible()

  await read.click()
  await expect(plan.locator(".flow-graph-drawer")).toHaveAttribute("data-node", AUTHORING_READ)
  await command(page, `/flow.create Add validation to authoring-demo ${GRAPH_REPO}`)

  await expect(validate).toBeVisible()
  await expect(plan).toHaveCount(1)
  await expect(plan).toHaveAttribute("data-testid", planId!)
  await expect(plan.locator(".flow-graph-drawer")).toHaveAttribute("data-node", AUTHORING_READ)
  await expect(plan.locator(".flow-graph-drawer")).toContainText("unchanged")
  await validate.click()
  await expect(plan.locator(".flow-graph-drawer")).toContainText("added")
  await expect(plan.locator(".flow-plan-key-changes")).toContainText("changed keys")
  // The source update moved the same plan beside its authoring card.
  const editor = page.locator('.smithers-card[data-kind="run-trace"]').last()
  const order = await page.locator('.smithers-card').evaluateAll(cards => cards.map(card => card.getAttribute("data-testid")))
  expect(order.indexOf(planId)).toBe(order.indexOf(await editor.getAttribute("data-testid")) - 1)
  await expect(page.locator('[data-toast-status="running"]')).toHaveCount(0)
  await page.reload()
  await expect(validate).toBeVisible()
  await expect(plan).toHaveCount(1)
  await expect(plan).toHaveAttribute("data-testid", planId!)
  await expect(plan.locator(".flow-graph-drawer")).toHaveAttribute("data-node", AUTHORING_VALIDATE)
  await expect(plan.locator(".flow-graph-drawer")).toContainText("added")

  await plan.locator('[data-flow="flow.run"]').click()
  await expect(page.locator('.smithers-card[data-kind="run-trace"]')).toHaveCount(3)
  const executed = page.locator('.smithers-card[data-kind="run-trace"]').last().locator('.run-trace[data-testid]')
  await expect(page.locator('.smithers-card[data-kind="run-trace"]').last()).toContainText("authoring-demo")
  await expect(executed).toHaveAttribute("data-testid", /^run-trace-(?!pending-).+/)
  const runId = (await executed.getAttribute("data-testid"))!.replace("run-trace-", "")
  await expect(page.getByTestId(`run-outcome-${runId}`)).toContainText("Finished")
  await executed.locator(`[data-flow="runs.trace.view"][data-flow-args="${runId} graph"]`).click()
  await expect(executed.locator('.flow-graph-node').filter({ hasText: "authoring/Validate" })).toHaveAttribute("data-state", "built")
})
