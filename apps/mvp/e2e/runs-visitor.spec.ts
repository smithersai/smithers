import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

requires("githubSignIn")
test.use(signedOut)
test("repository runs: a visitor sees a sign-in path", async ({ page }) => {
  await page.goto("/smithersai/smithers/actions")
  await expect(page.getByRole("main", { name: "Runs", exact: true }).getByRole("link", { name: "Sign in with GitHub" })).toBeVisible()
})

test("personal runs: a visitor reads without authenticated requests", async ({ page }) => {
  let cloudRequests = 0
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/cloud-runs") cloudRequests++ })
  await page.goto("/app/runs")
  await expect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible()
  await expect(page.getByText("No runs yet", { exact: true })).toBeVisible()
  expect(cloudRequests).toBe(0)
})
