import type { Page } from "@playwright/test"
import { Docs } from "@smthrs/views"
import { expect } from "./fixtures"

/** Read the independently deployed source, never a fixed title or Smithers' own answer as the oracle. */
export const liveDocs = async (page: Page) => {
  const url = "https://vibelang.sh/llms.txt"
  const response = await page.request.get(url)
  expect(response.ok(), "The live docs index must load").toBe(true)
  const index = Docs.parse(await response.text(), url)
  expect(index.pages.length).toBeGreaterThan(1)
  const seed = index.pages[0]!
  const query = seed.title.match(/[a-z]{4,}/i)?.[0] ?? seed.title
  const matches = Docs.search(index, query, 8)
  expect(matches.length).toBeGreaterThan(0)
  const selected = matches[0]!
  const excluded = index.pages.find((entry) => !matches.some((match) => match.path === entry.path))!
  expect(excluded, "Search must narrow the index").toBeDefined()
  const content = await page.request.get(selected.url)
  expect(content.ok(), `The indexed page ${selected.path} must load`).toBe(true)
  const markdown = await content.text()
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]
  const code = /^```[^\n]*\n([\s\S]+?)\n```/m.exec(markdown)?.[1]
  expect(heading, "The indexed page must have a heading").toBeTruthy()
  expect(code, "The page must exercise Markdown code rendering").toBeTruthy()
  return { index, query, selected, excluded, heading: heading!, code: code! }
}

export const renderedDocs = async (region: ReturnType<Page["getByRole"]>, source: Awaited<ReturnType<typeof liveDocs>>) => {
  await expect(region.getByRole("heading", { name: source.heading, exact: true }).first()).toBeVisible({ timeout: 60_000 })
  await expect(region.locator("pre").first()).toContainText(source.code)
  await expect(region).not.toContainText("```")
}
