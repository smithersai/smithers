import { expect, test } from "./devices"
import { requires } from "./target"

// A repository's flows run by hand (docs/features/actions.md#running-a-flow-by-hand): a Member opens the test
// repository's runs, chooses its `hand` flow in the Run card, fills the form its payload schema draws, and watches the
// run it started on its page to Done; then runs it again with Retry, and stops a long one. The repository
// (`E2E_REPO_FLOWS_REPOSITORY`, never a smithersai one) holds e2e/fixtures/ci-repo on its default branch, whose
// manifest gives `hand` a `manual` trigger; the instance runs with REPO_FLOWS=true, REPO_FLOWS_REPOSITORIES allowing
// it, and the GitHub App installed there (e2e/ci.spec.ts says how). Nothing is scripted: ChatApi reads the flow at the
// branch's head as the App and starts it on its own Durable Object.

const REPOSITORY = process.env.E2E_REPO_FLOWS_REPOSITORY ?? ""

test.describe("a repository's runs", () => {
  test("run by hand: the flow's form, its run on its page to Done, Retry, and a long one stopped", {
    annotation: { type: "summary", description: "Run a repository's flow by hand from its form, watch it, run it again, stop a long one." },
  }, async ({ devices }) => {
    requires("githubApp", "repoFlows", "member")
    test.setTimeout(25 * 60_000)
    const [a] = await devices.open("Maya")
    const page = a.page
    const form = page.getByRole("form", { name: "By hand" })
    const runPage = /\/actions\/runs\/hand(%3A|:)/
    await test.step("Open the repository's runs and choose the flow", async () => {
      await page.goto(`/${REPOSITORY}/actions`)
      await page.getByRole("button", { name: "By hand", exact: true }).click({ timeout: 60_000 })
      await expect(form).toBeVisible({ timeout: 60_000 })
      await expect(page.getByLabel("Branch", { exact: true })).not.toHaveValue("")
    })
    await test.step("Fill its form and run it", async () => {
      await form.getByLabel("Greeting").fill(`hello ${devices.word}`)
      await form.getByRole("button", { name: "Run", exact: true }).click()
      await expect(page).toHaveURL(runPage, { timeout: 60_000 })
      await expect(page.getByRole("heading", { name: "hand", exact: true })).toBeVisible({ timeout: 60_000 })
    })
    const first = page.url()
    await test.step("It runs to Done", async () => {
      await expect(page.getByText("Done", { exact: true }).first()).toBeVisible({ timeout: 10 * 60_000 })
    })
    await test.step("Retry runs it again as a new run", async () => {
      await page.getByRole("button", { name: "Retry", exact: true }).click()
      await expect.poll(() => page.url(), { timeout: 60_000 }).not.toBe(first)
      await expect(page).toHaveURL(runPage)
      await expect(page.getByText("Done", { exact: true }).first()).toBeVisible({ timeout: 10 * 60_000 })
    })
    await test.step("A long one stops", async () => {
      await page.goto(`/${REPOSITORY}/actions`)
      await page.getByRole("button", { name: "By hand", exact: true }).click({ timeout: 60_000 })
      await form.getByLabel("Greeting").fill(`long ${devices.word}`)
      await form.getByLabel("Wait").selectOption("300")
      await form.getByRole("button", { name: "Run", exact: true }).click()
      await expect(page).toHaveURL(runPage, { timeout: 60_000 })
      await page.getByRole("button", { name: "Stop", exact: true }).click({ timeout: 5 * 60_000 })
      await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible({ timeout: 5 * 60_000 })
      await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
    })
  })
})
