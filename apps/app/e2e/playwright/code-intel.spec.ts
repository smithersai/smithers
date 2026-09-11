import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { localApiGet, localApiPost } from "./localApi"

/*
 * Code intelligence T1 (docs/code-intel/PLAN.md §6): against the real local
 * origin and the REAL typescript-language-server. A TypeScript fixture
 * project opens through the chrome's prompt fallback, `/files.read
 * src/index.ts` renders the file card with tokens, a pointer at rest on a
 * token runs code.hover and the answer lands under the line, `/code.
 * diagnostics` puts the deliberate error under its line and in the count,
 * and ⌘-click on `greet` runs code.definition, which opens greet.ts as a
 * second card anchored at the defining line. Without a language server on
 * the machine the spec skips and names the install line; nothing stands in
 * for the server.
 */

test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the stub suite; the real endpoint is the manual proof")

const require = createRequire(__filename)
const opened: Array<string> = []
const temporary: Array<string> = []

/** The fixture the Bun host seam drives (src/bun/lsp/LspFixture.ts), written by the spec's own process. */
const writeFixture = (root: string): void => {
  mkdirSync(join(root, "src"), { recursive: true })
  mkdirSync(join(root, "node_modules"), { recursive: true })
  symlinkSync(dirname(require.resolve("typescript/package.json")), join(root, "node_modules", "typescript"))
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true, types: [] },
      include: ["src"]
    })
  )
  writeFileSync(
    join(root, "src", "greet.ts"),
    [
      "export interface Greeting {",
      "  readonly name: string",
      "  readonly count: number",
      "}",
      "",
      "export const greet = (greeting: Greeting): string => `hello ${greeting.name} x${greeting.count}`",
      ""
    ].join("\n")
  )
  writeFileSync(
    join(root, "src", "index.ts"),
    [
      "import { greet } from \"./greet\"",
      "",
      "const message = greet({ name: \"smithers\", count: 2 })",
      "const length = message.lenght",
      "export { length }",
      ""
    ].join("\n")
  )
}

/** The chrome's Open repository, answered through the window.prompt fallback. */
const openRepo = async (page: Page, path: string): Promise<void> => {
  page.once("dialog", (dialog) => void dialog.accept(path))
  await page.getByTestId("composer-repo-trigger").click()
  await page.getByTestId("chrome-open-repo").click()
}

/** Type a registered slash command into the composer and send it. */
const command = async (page: Page, text: string): Promise<void> => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-send").click()
}

test.beforeEach(async ({ page }) => {
  // Cards persist per browser profile; every test starts from an empty transcript.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test.afterEach(async ({ page, request }) => {
  try {
    if (opened.length > 0) {
      const listed = await localApiGet(page, request, "/api/repos")
      if (listed.ok()) {
        const { repos } = (await listed.json()) as { repos: Array<{ id: string; path: string }> }
        for (const repo of repos) {
          if (opened.includes(repo.path)) await localApiPost(page, request, "/api/repo/close", { repoId: repo.id })
        }
      }
    }
  } finally {
    opened.length = 0
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
  }
})

test("T1: a TypeScript file card highlights, hovers, lists its diagnostics, and ⌘-click opens the definition at its line", async ({ page, request }) => {
  const root = mkdtempSync(join(tmpdir(), "smithers-code-intel-"))
  temporary.push(root)
  writeFixture(root)
  const rootPath = realpathSync(root)

  await page.goto("/")
  await openRepo(page, rootPath)
  opened.push(rootPath)
  await expect(page.getByTestId("repo-chip")).toBeVisible()

  const listed = await localApiGet(page, request, "/api/repos")
  expect(listed.status()).toBe(200)
  const { repos } = (await listed.json()) as { repos: Array<{ id: string; path: string; name: string }> }
  const repo = repos.find((row) => row.path === rootPath)
  expect(repo).toBeDefined()
  if (repo === undefined) return
  expect(repo.name).toBe(basename(rootPath))

  // The honest probe: the host names the missing server with its install line; the spec skips on that answer.
  const probe = await localApiPost(page, request, "/api/lsp/hover", { repoId: repo.id, path: "src/greet.ts", line: 6, character: 14 })
  if (probe.status() === 409) {
    const body = (await probe.json()) as { error: { code: string; message: string; install?: string } }
    test.skip(true, `${body.error.message}${body.error.install === undefined ? "" : ` (install: ${body.error.install})`}`)
  }
  expect(probe.status()).toBe(200)

  // /files.read renders the file card; the token view replaces the plain block once the grammar has loaded.
  await command(page, "/files.read src/index.ts")
  const card = page.getByTestId(`card-file-${repo.id}-src/index.ts`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.locator('[data-slot="code-language"]')).toHaveText("TypeScript")
  const view = card.locator('[data-slot="code-view"]')
  await expect(view).toHaveAttribute("data-state", "ready", { timeout: 30_000 })
  await expect(view).toHaveAttribute("data-language", "typescript")
  // The first painted lines are readable before the asynchronous grammar
  // finishes. Wait for actual colored tokens, as the adapter contract does.
  await expect.poll(() => view.locator("[data-line] span[style]").count(), { timeout: 30_000 }).toBeGreaterThan(1)
  // Nothing about the server is stated before anyone asked it.
  await expect(card.locator("[data-intel]")).toHaveCount(0)
  await expect(card.locator('[data-slot="code-diagnostics-count"]')).toHaveCount(0)

  // Pointer rest on `greet` (line 3) runs code.hover; the answer lands under the line.
  const greet = view.locator('[data-line="3"] [data-char]', { hasText: /^greet$/ })
  await expect(greet).toBeVisible()
  await greet.hover()
  const hover = card.locator('[data-slot="code-hover"]')
  await expect(hover).toBeVisible({ timeout: 60_000 })
  await expect(hover).toContainText("greet")
  await expect(hover).toContainText("Greeting")
  expect(await hover.evaluate((node) => node.closest("[slot]")?.getAttribute("slot"))).toBe("annotation-3")

  // The slash door: /code.diagnostics puts the deliberate error under line 4 and in the count line.
  await command(page, "/code.diagnostics src/index.ts")
  await expect(card.locator('[data-slot="code-diagnostics-count"]')).toHaveText("1 error · 0 warnings", { timeout: 30_000 })
  const diagnostic = card.locator('[data-slot="code-diagnostic"]')
  await expect(diagnostic).toHaveCount(1)
  await expect(diagnostic).toHaveAttribute("data-severity", "error")
  await expect(diagnostic).toContainText("lenght")
  expect(await diagnostic.evaluate((node) => node.closest("[slot]")?.getAttribute("slot"))).toBe("annotation-4")

  // ⌘-click (Ctrl-click off macOS) on `greet` runs code.definition: greet.ts opens as its own card, anchored at the defining line.
  await greet.click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] })
  const target = page.getByTestId(`card-file-${repo.id}-src/greet.ts`)
  await expect(target).toBeVisible({ timeout: 60_000 })
  await expect(target.locator(".world-card-panel")).toHaveAttribute("data-line", "6")
  const targetView = target.locator('[data-slot="code-view"]')
  await expect(targetView).toHaveAttribute("data-state", "ready", { timeout: 30_000 })
  const anchored = targetView.locator('[data-line="6"][data-selected-line]')
  await expect(anchored).toHaveCount(1)
  // The line is in view: inside the panel's own scroll box, not merely present.
  const inView = await anchored.evaluate((line) => {
    const panel = line.getRootNode() instanceof ShadowRoot ? (line.getRootNode() as ShadowRoot).host.closest(".world-card-panel") : null
    if (panel === null) return false
    const row = line.getBoundingClientRect()
    const box = panel.getBoundingClientRect()
    return row.top >= box.top && row.bottom <= box.bottom
  })
  expect(inView).toBe(true)
  // The first card is still the first card: the definition opened a second one rather than replacing it.
  await expect(card).toBeVisible()
})
