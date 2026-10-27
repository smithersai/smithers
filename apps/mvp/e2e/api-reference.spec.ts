import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

test.use(signedOut)

const open = async (page: Page, slug: string) => {
  requires("docsSite")
  const response = await page.goto(`/docs/reference/api/${slug === "" ? "" : `${slug}/`}`)
  expect(response?.status()).toBe(200)
  return page.locator("main")
}

test("engine reference identifies the flow-owned typed conflict", async ({ page }) => {
  const main = await open(page, "engine")
  await expect(main).toContainText("FlowRuntime.ExecutionIdentityConflict")
  await expect(main).not.toContainText("FlowEngine.ExecutionIdentityConflict")
  await expect(main).toContainText("typed failure")
})

test("journal and engine-store publish fact and reconstruction namespaces", async ({ page }) => {
  await expect(await open(page, "engine-store")).toContainText("DeferredClockFold")
  const journal = await open(page, "journal")
  for (const name of ["CallFact", "StepFact"]) await expect(journal).toContainText(name)
})

for (const [slug, names] of [
  ["flow", ["StatusOptions", "Inspection", "ExecutionOptions", "maximumDispatchDigests", "Observation", "runsStarted", "recordModelCall"]],
  ["engine-store", ["ArtifactGcErrorCode", "RequestedResumeReason", "heartbeatReceipts", "DeferredDigest", "waitingTreeMaxDepth"]],
  ["journal", ["decodeLineageId", "decodeTimestampMs", "contentDigest", "stateEventType"]],
  ["canonical", ["Limits", "IssueCode", "StrictOptions"]],
  ["crypto", ["makeDigestPartsSync"]],
  ["sandbox", ["ExecuteOptions", "ToolFailure", "Checkpoint", "RebaseOptions", "RunStep", "ServerControl", "decodeClientControl"]]
] as const) {
  test(`${slug} reference publishes its supported members`, async ({ page }) => {
    const main = await open(page, slug)
    for (const name of names) await expect(main).toContainText(name)
  })
}

test("agent reference states the default wait ceiling", async ({ page }) => {
  const main = await open(page, "agent")
  const row = main.getByRole("row").filter({ has: page.locator("code", { hasText: /^capacity$/ }) })
  await expect(row).toContainText("3,600,000 ms")
  await expect(row).toContainText("maxParkMillis")
  await expect(row).not.toContainText("no wait ceiling")
})

test("harness reference indexes lifecycle and realm execution", async ({ page }) => {
  const main = await open(page, "harness")
  await expect(main).toContainText("37 public root modules")
  for (const name of ["QuickJSLifecycle", "RealmFlow", "layerDefaultVariant"]) await expect(main).toContainText(name)
})

test("build reference publishes install and manifest contracts", async ({ page }) => {
  const main = await open(page, "build")
  for (const name of ["Requires", "InstallFlow", "StoreManifest", "storeManifest", "linkedTreeManifest", "lookupEnvironmentNames"]) {
    await expect(main.getByRole("row").filter({ hasText: name }).first()).toContainText(name)
  }
})

test("library roster links build, targets and views", async ({ page }) => {
  const main = await open(page, "")
  for (const name of ["build", "targets", "views"]) {
    const link = main.getByRole("link", { name: `@smthrs/${name}`, exact: true })
    await expect(link).toHaveAttribute("href", `/docs/reference/api/${name}/`)
    await link.click()
    await expect(page.getByRole("heading", { level: 1 })).toContainText(name)
    await open(page, "")
  }
})

test("library roster names the private UI contributor reference", async ({ page }) => {
  const main = await open(page, "")
  const row = main.getByRole("row").filter({ hasText: "@smthrs/ui" })
  await expect(row).toContainText("workspace-private")
  await expect(row).toContainText("no published API page")
  await expect(row.getByRole("link", { name: "@smthrs/ui", exact: true })).toHaveAttribute("href", /\/packages\/smithers\/ui\/docs\/api\.md$/)
})
