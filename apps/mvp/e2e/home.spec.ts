import { expect, step, test } from "./fixtures"
import { requires, target } from "./target"

// A repository's own home (docs/features/home.md, decision 0014 §4, F5), against the real app, Worker, Postgres,
// Electric, GitHub and Code Storage. The fixture is the small public `smithersai/home-fixture`, whose
// `.smithers/home.json` declares a prompt, text, a link, a Markdown file, two app blocks (one for a command the app has,
// one for a flow it hasn't) and a block of a kind the app doesn't know. Cloning it is idempotent, so a second run finds
// it ready. Locally the run needs the Code Storage organization in the dev server's environment; a deployment holds it.
// The declared home is drawn from the clone, a Member's request (worker/RepoApi.ts `canClone`) that the `repo/clone`
// remote flow finishes (worker/RepoApi.ts `start`, worker/flows/RepoClone.ts); a repository without one shows GitHub's
// preview of its README before any clone.

requires("codeStorage")

const REPO = "/smithersai/home-fixture"

test("declared: a repository's own home draws its blocks, Code opens its tree, a file opens by its URL, and Home comes back", async ({ page }) => {
  requires("member")
  test.setTimeout(240_000)
  const header = page.locator('header[aria-label="Repository"]')
  const home = page.getByRole("region", { name: "Home" })
  const tabs = page.getByRole("navigation", { name: "Repository pages" })
  const composer = page.getByRole("textbox", { name: "Message Smithers" })

  await step("Open smithersai/home-fixture: it opens on its own home", async () => {
    await page.goto(REPO)
    await expect(header).toContainText("smithersai / home-fixture", { timeout: 30_000 })
    // Clone shows only for a repository Smithers hasn't got.
    const clone = header.getByRole("button", { name: "Clone" })
    await expect(home.or(clone)).toBeVisible({ timeout: 60_000 })
    if (await clone.isVisible()) await clone.click()
    await expect(home.getByText("A fixture repository that declares its own home.")).toBeVisible({ timeout: 120_000 })
  })

  await step("The blocks .smithers/home.json declares, drawn as data", async () => {
    if (target === "deployment") {
      await expect(home.getByRole("heading", { name: "What should we work on?" })).toHaveCount(0)
      await expect(home.getByRole("link", { name: "Ask Smithers…" })).toHaveCount(0)
      await expect(home.getByRole("link", { name: "Make a flow" })).toHaveCount(0)
    } else {
      await expect(home.getByRole("heading", { name: "What should we work on?" })).toBeVisible()
      await expect(home.getByRole("link", { name: "Ask Smithers…" })).toHaveAttribute("href", `${REPO}/tree/main`)
    }
    await expect(home.getByRole("link", { name: "Smithers docs" })).toHaveAttribute("target", "_blank")
    // The Markdown block: the repository's own file at the same commit.
    await expect(home.getByRole("heading", { name: "Welcome home" })).toBeVisible({ timeout: 30_000 })
    // An app block shows only for a command the app has; a kind the app doesn't know is skipped.
    if (target !== "deployment") await expect(home.getByRole("link", { name: "Make a flow" })).toBeVisible()
    await expect(home.getByText("Fix an issue")).toHaveCount(0)
    // No tree on the home: it is one tab away.
    await expect(tabs.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page")
    await expect(page.getByRole("link", { name: "README.md" })).toHaveCount(0)
  })

  await step("Reload: the home again", async () => {
    await page.reload()
    await expect(home.getByText("A fixture repository that declares its own home.")).toBeVisible({ timeout: 30_000 })
  })

  await step("Code: the file tree at main, one tab away", async () => {
    await tabs.getByRole("link", { name: "Code" }).click()
    await expect(page).toHaveURL(new RegExp(`${REPO}/tree/main$`))
    await expect(page.getByRole("link", { name: "README.md" }).first()).toBeVisible({ timeout: 30_000 })
  })

  await step("A file by its URL, with the Home and Code tabs", async () => {
    await page.goto(`${REPO}/blob/main/docs/intro.md`)
    await expect(page.getByText("drawn on its home", { exact: false })).toBeVisible({ timeout: 30_000 })
    await expect(tabs.getByRole("link", { name: "Code" })).toHaveAttribute("aria-current", "page")
  })

  await step("Home: back to the repository's own home", async () => {
    await tabs.getByRole("link", { name: "Home" }).click()
    await expect(page).toHaveURL(new RegExp(`${REPO}$`))
    await expect(home.getByRole("heading", { name: "Welcome home" })).toBeVisible({ timeout: 30_000 })
  })

  if (target === "deployment") return

  await step("Ask Smithers…: the workspace at main, its composer open", async () => {
    await home.getByRole("link", { name: "Ask Smithers…" }).click()
    await expect(page).toHaveURL(new RegExp(`${REPO}/tree/main$`))
    await expect(composer).toBeVisible({ timeout: 30_000 })
  })

  await step("Make a flow: /flow.new in the composer", async () => {
    await page.goto(REPO)
    await home.getByRole("link", { name: "Make a flow" }).click()
    await expect(page).toHaveURL(new RegExp(`${REPO}/tree/main$`))
    await expect(composer).toHaveValue("/flow.new ", { timeout: 30_000 })
  })
})

test("absent: a repository without a home opens on its tree, with repository navigation", async ({ page }) => {
  const header = page.locator('header[aria-label="Repository"]')
  const readme = page.getByText("Well hello there!")

  await step("Open octocat/Spoon-Knife: no home, so its file tree and README", async () => {
    await page.goto("/octocat/Spoon-Knife")
    await expect(header).toContainText("octocat / Spoon-Knife", { timeout: 30_000 })
    const clone = header.getByRole("button", { name: "Clone" })
    await expect(readme.or(clone)).toBeVisible({ timeout: 60_000 })
    if (await clone.isVisible()) await clone.click()
    await expect(readme).toBeVisible({ timeout: 120_000 })
  })

  await step("The repository frame keeps Home and Code navigation", async () => {
    const tabs = page.getByRole("navigation", { name: "Repository pages" })
    await expect(tabs.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("href", "/octocat/Spoon-Knife")
    await expect(tabs.getByRole("link", { name: "Code", exact: true })).toHaveAttribute("href", "/octocat/Spoon-Knife/tree/main")
    await expect(tabs.getByRole("link", { name: "Docs", exact: true })).toHaveCount(0)
    await expect(page.getByRole("region", { name: "Home" })).toHaveCount(0)
    await expect(page.getByRole("link", { name: "README.md" }).first()).toBeVisible()
  })
})
