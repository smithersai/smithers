import { expect } from "@playwright/test"
import { writeFile } from "node:fs/promises"
import { strictTest as test } from "./watch"
import { BRANCH_UNAVAILABLE, COMMIT_UNAVAILABLE, COMPARE_UNAVAILABLE, COPY_DRAFT, FILE_UNAVAILABLE, FLOW_UNAVAILABLE, TERMINAL_UNAVAILABLE } from "../src/features/chat/engineAvailability"
import { requires, syncedRepository, target } from "./target"

// These are ordinary browser.newContext pages: WebKit uses private storage here.
// No fixture writes. Ordinary app startup can register watches and credentials;
// this companion never commits a TODO, saves a flow or launches a terminal.
for (const width of [390, 768, 1280]) {
  test.describe(`${width}px private storage`, () => {
    test.use({ viewport: { width, height: 844 } })
    test("flow code and TODO admission are usable or explain their missing engine", async ({ page }, info) => {
      requires("member")
      if (target === "deployment") requires("syncedRepository")
      const writes: string[] = []
      page.context().on("request", request => {
        const path = new URL(request.url()).pathname
        if ((path.endsWith("/stack") || path.startsWith("/api/flows/") || path.startsWith("/api/flow-drafts") || path === "/api/flows/save" || path === "/api/terminals") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(`${request.method()} ${path}`)
      })
      await page.goto("/version.json")
      const storage = await page.evaluate(async () => {
        try {
          await navigator.storage.getDirectory()
          return { available: true, stage: "getDirectory" }
        } catch (error) {
          return { available: false, stage: "getDirectory", error: error instanceof DOMException ? error.name : "unknown" }
        }
      })
      const receipt = info.outputPath("storage-capability.json")
      await writeFile(receipt, JSON.stringify(storage))
      await info.attach("storage-capability", { path: receipt, contentType: "application/json" })
      await page.goto("/app/flows/code/private-availability-absent")
      if (storage.available) {
        await expect(page.getByText("No such flow", { exact: true })).toBeVisible({ timeout: 30_000 })
      } else {
        await expect(page.getByText(FLOW_UNAVAILABLE, { exact: true })).toBeVisible()
      }
      await page.goto(`/${target === "deployment" ? syncedRepository() : "octocat/Spoon-Knife"}/stack`)
      await page.getByRole("button", { name: "New TODO", exact: true }).click()
      const draft = page.getByRole("form", { name: "TODO draft" }).first()
      await draft.getByLabel("Title", { exact: true }).fill("Private availability check")
      await draft.getByLabel("Prompt", { exact: true }).fill("Keep this draft local.")
      if (storage.available) await expect(draft.getByRole("button", { name: "Commit", exact: true })).toBeEnabled()
      else {
        await expect(draft.getByRole("button", { name: "Commit", exact: true })).toBeDisabled()
        await expect(page.getByText(`${COMMIT_UNAVAILABLE} ${COPY_DRAFT}`, { exact: true })).toBeVisible()
        // Private-mode refusal must also cover keyboard submission without erasing input.
        await draft.getByLabel("Prompt", { exact: true }).press("Meta+Enter")
        await expect(draft.getByLabel("Title", { exact: true })).toHaveValue("Private availability check")
      }
      await draft.getByRole("button", { name: "Discard", exact: true }).click()
      // A private engine cannot track a branch. This route therefore performs no server mutation.
      // Chromium's working terminal journey remains covered by mobile.spec.ts locally.
      if (!storage.available) {
        await page.goto("/octocat/Spoon-Knife/tree/test-branch?terminal=me")
        await expect(page.getByRole("region", { name: "Terminal", exact: true })).toBeVisible()
        await expect(page.getByText(TERMINAL_UNAVAILABLE, { exact: true })).toBeVisible()
        for (const [search, message] of [["", BRANCH_UNAVAILABLE], ["?edit=README.md", FILE_UNAVAILABLE], ["?compare=true", COMPARE_UNAVAILABLE]] as const) {
          await page.goto(`/octocat/Spoon-Knife/tree/test-branch${search}`)
          await expect(page.getByText(message, { exact: true })).toBeVisible()
        }
      }
      expect(writes, "the companion must not mutate TODOs, flows or terminals").toEqual([])
      info.annotations.push({ type: "summary", description: `Device storage ${storage.available ? "opens" : "refuses"}; feature actions report their real availability.` })
    })
  })
}
