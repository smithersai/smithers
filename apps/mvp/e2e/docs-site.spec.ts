import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

// Local coverage: the service-worker routing test below runs under alchemy dev. The docs-content test needs docsSite because alchemy dev does not serve the separate Starlight Worker or custom-domain routes.
//
// The docs site shares the app's hostname on a deployment's custom domain (infra/DocsSite.ts): Cloudflare routes its
// paths to it, and the app's service worker, in control of every page on the origin after one visit to the app, must
// leave those paths to the network (src/pwa.ts DOCS_SITE). A visitor needs no session for either.
test.use(signedOut)

/**
 * Opens the app as a returning visitor: once its service worker is active, a reload puts the page under its control,
 * as every later visit to the origin is.
 */
const underServiceWorker = async (page: Page) => {
  await page.goto("/app")
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
}

test("docs beside the app: the app's service worker leaves the docs site's pages to the network", { annotation: { type: "summary", description: "Once the app's service worker controls the origin, a docs page still comes from the network, while the app's own pages come from its shell." } }, async ({ page }) => {
  await underServiceWorker(page)

  const docs = await page.goto("/docs/installation/")
  expect(docs?.fromServiceWorker()).toBe(false)

  const app = await page.goto("/app/flows")
  expect(app?.fromServiceWorker()).toBe(true)
})

test("docs beside the app: /docs is the docs site, and every other path is the app", { annotation: { type: "summary", description: "On the deployment's domain, /docs and llms.txt answer from the docs site, and / is the app's landing." } }, async ({ page }) => {
  requires("docsSite")
  await underServiceWorker(page)

  const docs = await page.goto("/docs")
  expect(docs?.status()).toBe(200)
  expect(new URL(page.url()).pathname).toBe("/docs/")
  await expect(page.locator('meta[name="generator"][content^="Starlight"]')).toHaveCount(1)

  await page.goto("/docs/installation/")
  await expect(page.getByRole("heading", { level: 1, name: "Install Smithers" })).toBeVisible()

  // A link with a query, as from a newsletter: a bare folder goes on with a slash, and a file keeps its query.
  await page.goto("/docs?ref=e2e")
  expect(new URL(page.url()).pathname).toBe("/docs/")
  await expect(page.locator('meta[name="generator"][content^="Starlight"]')).toHaveCount(1)

  const llms = await page.request.get("/llms.txt?ref=e2e")
  expect(llms.status()).toBe(200)
  expect(llms.headers()["content-type"]).toContain("text/plain")
  expect(await llms.text()).toContain("/docs/installation/")

  await page.goto("/")
  await expect(page.getByRole("link", { name: "Get started for free" })).toBeVisible()
  await expect(page.locator('meta[name="generator"]')).toHaveCount(0)
})

test("docs quickstart follows the current visitor home and repository navigation", async ({ page }) => {
  requires("docsSite")
  await page.goto("/docs/quickstart/")
  const main = page.getByRole("main")
  await expect(main).toContainText("Get started for free")
  await expect(main).toContainText("opens on Home")
  await expect(main).toContainText("Choose Code")
  await expect(main).not.toContainText("top right")
  await page.goto("/")
  await expect(page.getByRole("link", { name: "Get started for free" })).toBeVisible()
  await page.goto("/smithersai/vibelang")
  const tabs = page.getByRole("navigation", { name: "Repository pages" })
  await expect(tabs.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page")
  await tabs.getByRole("link", { name: "Code", exact: true }).click()
  await expect(page).toHaveURL(/\/tree\/main$/)
})

test("hosted docs use the product introduction without a global CLI release banner", async ({ page }) => {
  requires("docsSite")
  await page.goto("/docs/")
  await expect(page.getByRole("main")).toContainText("Automate maintaining your codebase")
  await expect(page.getByRole("main")).not.toContainText("Smithers 1.0 release candidate")
  await page.goto("/docs/local-quickstart/")
  await expect(page.getByRole("main")).toContainText('already sets both seat and model to "openai:gpt-6-sol"')
  await page.goto("/docs/flows/")
  await expect(page.getByRole("main")).toContainText("System flows are protected actions")
  await expect(page.getByRole("main")).toContainText("Learning proposals are suggested improvements")
})
