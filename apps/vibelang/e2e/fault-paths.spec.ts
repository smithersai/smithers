// Playwright discovers browser specs only by JS/TS extension.
import { expect, test } from "./coverage"

const local = `http://127.0.0.1:${process.env.E2E_PORT ?? process.env.E2E_4502 ?? 4173}`
const wiki = (page: import("./coverage").Page) => page.getByRole("region", { name: "Wiki", exact: true })

test("a save that fails says so, keeps the text, and the next save opens the change", async ({ page }) => {
  await page.goto(`${local}/e2e/runtime/index.html?fault=wiki-edit`)
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
  await page.getByRole("button", { name: "Wiki", exact: true }).click()
  await wiki(page).getByRole("button", { name: "Edit", exact: true }).click()
  const editor = wiki(page).getByRole("textbox", { name: "Edit Home" })
  const text = (await editor.inputValue()) + "\nSaved on the second try.\n"
  await editor.fill(text)
  await wiki(page).getByRole("button", { name: "Save", exact: true }).click()
  await expect(wiki(page).getByText("Couldn't save. Retry.", { exact: true })).toBeVisible()
  await expect(editor).toHaveValue(text)
  await wiki(page).getByRole("button", { name: "Save", exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(wiki(page).getByRole("link", { name: "Review", exact: true })).toHaveAttribute("href", /\/pull\/[0-9]+$/)
})

test("after a save, a page shows the repository's copy, not the build's", async ({ page }) => {
  await page.goto(`${local}/e2e/runtime/index.html?fault=wiki-repository`)
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
  await page.getByRole("button", { name: "Wiki", exact: true }).click()
  await wiki(page).getByRole("link", { name: "Benchmark methods and measurements", exact: true }).click()
  await expect(wiki(page).getByRole("button", { name: "Edit", exact: true })).toBeVisible()
  await expect(wiki(page).getByText("A real repository page.", { exact: true })).toHaveCount(0)
  await wiki(page).getByRole("button", { name: "Edit", exact: true }).click()
  const editor = wiki(page).getByRole("textbox", { name: "Edit Benchmarks" })
  await expect(editor).toHaveValue(/^# Wiki fixture\n\nA real repository page\./)
  await editor.fill((await editor.inputValue()) + "\nA line from the browser.\n")
  await wiki(page).getByRole("button", { name: "Save", exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(wiki(page).getByRole("heading", { name: "Wiki fixture", exact: true })).toBeVisible()
  await expect(wiki(page).getByText("A real repository page.", { exact: true })).toBeVisible()
  // The repository copy's relative link resolves to the wiki's own page.
  await expect(wiki(page).getByRole("link", { name: "roadmap", exact: true })).toHaveAttribute("href", "/wiki/roadmap")
})

test("a pause the server doesn't take is visible during the tour", async ({ page }) => {
  await page.goto(`${local}/e2e/runtime/index.html?fault=tour-control`)
  await page.getByRole("button", { name: "Learn more", exact: true }).click()
  const bar = page.locator(".vl-theatre-bar")
  await expect(bar).toHaveAttribute("data-step", "1")
  await page.getByRole("button", { name: "Pause", exact: true }).click()
  const alert = page.getByRole("region", { name: "Walkthrough" }).getByRole("alert")
  await expect(alert).toHaveText("Connection lost")
  await page.getByRole("button", { name: "Pause", exact: true }).click()
  await expect(alert).toHaveCount(0)
  await expect(bar).toHaveAttribute("data-paused", "true")
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible()
})

for (const [fault, error, step, href] of [
  ["wiki-forbidden", "Not allowed.", "", ""],
  ["wiki-conflict", "The page changed. Reload the editor.", "", ""],
  ["wiki-connect", "Connect GitHub.", "Connect GitHub", ""],
  ["wiki-fork", "Fork on GitHub.", "Fork", "https://github.com/smithersai/smithers/fork"],
  ["wiki-install", "Install Smithers on your fork.", "Install", "/api/auth/install"],
] as const) {
  test(`a save refused with "${error}" keeps the text and names it`, async ({ page }) => {
    await page.goto(`${local}/e2e/runtime/index.html?fault=${fault}`)
    await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
    await page.getByRole("button", { name: "Wiki", exact: true }).click()
    await wiki(page).getByRole("button", { name: "Edit", exact: true }).click()
    const editor = wiki(page).getByRole("textbox", { name: "Edit Home" })
    const text = (await editor.inputValue()) + "\nRefused.\n"
    await editor.fill(text)
    await wiki(page).getByRole("button", { name: "Save", exact: true }).click()
    const alert = wiki(page).locator(".vl-wiki-edit-error")
    await expect(alert).toContainText(error)
    await expect(editor).toHaveValue(text)
    if (step === "Connect GitHub") await expect(alert.getByRole("button", { name: step, exact: true })).toBeVisible()
    else if (step !== "") await expect(alert.getByRole("link", { name: step, exact: true })).toHaveAttribute("href", href)
    else await expect(alert.getByRole("link")).toHaveCount(0)
  })
}
