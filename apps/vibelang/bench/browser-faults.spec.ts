// Stays .ts: Playwright collects test files by JS/TS extension only.
// Fault-path coverage workloads (decision 0017). They run the `e2e` build, whose fault pages put a faulty Effect
// service under the real app (test/support/FaultyFactory.vibe, test/support/FaultyActions.vibe); no request is
// intercepted. Their Chromium counts merge into the benchmark coverage gate. They are not timing benchmarks: the e2e
// build is not what people run, so these artifacts record steps and results, never durations.
import { test, expect, type Page } from "@playwright/test"
import { collectBrowserCoverage, save } from "./browser-support.ts"

const live = process.env.BENCH_LIVE === "1"
const runtime = "/e2e/runtime/index.html"

/** One fault page, its steps, and the artifact `fault-coverage-<name>` naming the build and the steps that passed. */
async function workload(page: Page, baseURL: string | undefined, name: string, body: (step: (label: string, run: () => Promise<void>) => Promise<void>) => Promise<void>) {
  const coverage = await collectBrowserCoverage(page.context(), page, baseURL, `faults-${name}`, { live, dist: "dist-e2e" })
  const steps: { step: string; passed: boolean }[] = []
  const step = async (label: string, run: () => Promise<void>) => {
    let passed = false
    try { await run(); passed = true } finally { steps.push({ step: label, passed }) }
  }
  try { await body(step) } finally {
    if (coverage) await coverage()
    await save(`fault-coverage-${name}`, { origin: baseURL, steps }, ["Fault-path coverage on the `e2e` build (unminified, with fault pages): no duration is recorded or quoted. A faulty Effect service fails once; nothing intercepts requests."], {
      live, deploymentRevision: null, build: { kind: "e2e-fault-coverage", minified: false },
      method: "Serial Chromium on the local e2e build. Each step drives the real app over one faulty Effect service and checks the screen the fault and its recovery leave. Counts only: Chromium precise coverage, merged by bench/merge-coverage.ts.",
    })
  }
}

test.beforeEach(() => { test.skip(live, "Fault pages exist only in the local e2e build.") })

test("a refused post and a refused tour show their reasons, and retry recovers", async ({ page, baseURL }) => {
  await workload(page, baseURL, "refusals", async step => {
    await page.goto(`${baseURL}${runtime}?fault=refuse`)
    await step("post-refused", async () => {
      await page.getByRole("button", { name: "Ask the agent" }).click()
      const prompt = page.getByRole("textbox", { name: "Message" })
      await prompt.fill("install")
      await prompt.press("Enter")
      const pending = page.locator("[data-pending='true']")
      await expect(pending).toContainText("Send failed")
      await pending.getByRole("button", { name: "Retry" }).click()
      await expect(page.locator("[data-role='assistant'][data-done='true']")).toHaveCount(1)
      await expect(pending).toHaveCount(0)
    })
    await page.goto(`${baseURL}${runtime}?fault=tour-refuse`)
    await step("tour-refused", async () => {
      await page.getByRole("button", { name: "Learn more" }).click()
      await expect(page.locator("[data-docked] .sui-chat-composer-status")).toHaveText("Agent busy")
      await page.getByRole("button", { name: "Expand the VibeLang home page" }).click()
      await page.getByRole("button", { name: "Learn more" }).click()
      await expect(page.locator(".vl-theatre-bar")).toBeVisible()
    })
  })
})

test("a broken event stream offers Reconnect, and the answer completes", async ({ page, baseURL }) => {
  await workload(page, baseURL, "disconnect", async step => {
    await page.goto(`${baseURL}${runtime}?fault=disconnect`)
    await step("events-unavailable", async () => {
      await page.keyboard.press("ControlOrMeta+k")
      const prompt = page.getByRole("textbox", { name: "Message" })
      await expect(prompt).toBeFocused()
      await prompt.fill("What is a service?")
      await prompt.press("Enter")
      const connection = page.getByRole("status", { name: "Connection" })
      await expect(connection).toHaveText("Disconnected")
      await page.getByRole("button", { name: "Reconnect" }).click()
      await expect(connection).toHaveText("Connected")
      await expect(page.locator(".sui-chat-message[data-role='assistant']")).toHaveAttribute("data-done", "true", { timeout: 15_000 })
    })
  })
})

test("a lost tour stream and an unavailable tour end keep the tour recoverable", async ({ page, baseURL }) => {
  await workload(page, baseURL, "tour", async step => {
    await page.goto(`${baseURL}${runtime}?fault=tour-events`)
    await step("tour-events-lost", async () => {
      await page.getByRole("button", { name: "Learn more" }).click()
      const bar = page.locator(".vl-theatre-bar")
      await expect(bar).toHaveAttribute("data-step", "1")
      await page.getByRole("button", { name: "Exit", exact: true }).click()
      await expect(bar).toHaveCount(0)
      await expect(page.locator("[data-docked] .sui-chat-composer-status")).toHaveText("Send failed")
    })
    await page.goto(`${baseURL}${runtime}?fault=end-tour-unavailable`)
    await step("tour-end-unavailable-at-step", async () => {
      await page.getByRole("button", { name: "Learn more", exact: true }).click()
      const bar = page.locator(".vl-theatre-bar")
      await expect(bar).toHaveAttribute("data-step", "1")
      await page.getByRole("button", { name: "Skip", exact: true }).click()
      await expect(bar).toHaveAttribute("data-step", "2")
      await page.getByRole("button", { name: "Exit", exact: true }).click()
      await expect(bar).toHaveAttribute("data-step", "2")
      await page.getByRole("button", { name: "Exit", exact: true }).click()
      await expect(bar).toHaveCount(0)
    })
  })
})

test("an unloadable image leaves the composer usable", async ({ page, baseURL }) => {
  await workload(page, baseURL, "media", async step => {
    await page.goto(`${baseURL}${runtime}?fault=media-image`)
    await step("media-failed", async () => {
      await expect(page.locator(".vl-app")).toHaveAttribute("data-surface", "chat")
      await expect(page.locator(".vl-empty-media")).toHaveCount(0)
      const prompt = page.getByRole("textbox", { name: "Message" })
      await prompt.fill("install")
      await prompt.press("Enter")
      await expect(page.locator(".sui-chat-message[data-role='assistant']")).toHaveAttribute("data-done", "true")
    })
  })
})

test("a failed sandbox read and start show their alerts, and Retry starts it", async ({ page, baseURL }) => {
  await workload(page, baseURL, "sandbox", async step => {
    const converse = async (fault: string) => {
      await page.goto(`${baseURL}${runtime}?fault=${fault}`)
      await page.getByRole("combobox", { name: "Visit as" }).selectOption("contributor")
      await page.getByRole("button", { name: "Ask the agent" }).click()
      await page.getByRole("dialog").getByRole("textbox").fill("hello")
      await page.getByRole("dialog").getByRole("button", { name: "Send" }).click()
      await expect(page.locator("[data-role='assistant'][data-done='true']")).toHaveCount(1)
      await page.getByRole("button", { name: "Sandboxes", exact: true }).click()
    }
    await step("sandbox-read-failed", async () => {
      await converse("sandbox-read")
      await expect(page.getByRole("alert").filter({ hasText: "Couldn't load the sandbox" })).toBeVisible()
    })
    await step("sandbox-start-failed-and-retried", async () => {
      await converse("sandbox-start")
      await page.getByRole("button", { name: "New sandbox" }).click()
      const alert = page.getByRole("alert").filter({ hasText: "Couldn't start a sandbox" })
      await expect(alert).toBeVisible()
      await alert.getByRole("button", { name: "Retry" }).click()
      await expect(page.getByRole("status", { name: "Sandbox", exact: true })).toHaveText("Running")
    })
  })
})

test("a lost role stream shows Connection lost, and Retry clears it", async ({ page, baseURL }) => {
  await workload(page, baseURL, "roles", async step => {
    await page.goto(`${baseURL}${runtime}?fault=roles`)
    await step("roles-lost-and-retried", async () => {
      await page.getByRole("combobox", { name: "Visit as" }).selectOption("contributor")
      const toast = page.locator(".sui-toast[data-tone='failed']")
      await expect(toast).toContainText("Connection lost.")
      await toast.getByRole("button", { name: "Retry" }).click()
      await expect(toast).toHaveCount(0)
    })
  })
})

test("a failed Actions list offers Retry, which loads it", async ({ page, baseURL }) => {
  await workload(page, baseURL, "actions", async step => {
    await page.goto(`${baseURL}/e2e/actions-runtime/index.html?role=contributor&fault=actions`)
    await step("actions-list-failed-and-retried", async () => {
      await page.keyboard.press("ControlOrMeta+k")
      const input = page.getByRole("dialog").getByRole("textbox", { name: "Message", exact: true })
      await input.fill("Hello")
      await input.press("Enter")
      await page.getByRole("button", { name: "Expand Actions", exact: true }).click()
      const pane = page.getByRole("region", { name: "Actions", exact: true })
      const alert = pane.getByRole("alert").filter({ hasText: "Couldn't load runs" })
      await expect(alert).toBeVisible()
      await alert.getByRole("button", { name: "Retry" }).click()
      await expect(alert).toHaveCount(0)
      await expect(pane.getByRole("button", { name: "Tour", exact: true })).toBeVisible()
    })
  })
})
