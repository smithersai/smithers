import { mkdir, symlink } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { scenario } from "./coverage/types"
import { createOwnedLocalRepo, expect, test } from "./support"
import { fileCard, openRepo, runAndClose, writeRepoFiles } from "./files-code/helpers"

const boot = async (page: import("@playwright/test").Page): Promise<void> => {
  await page.goto("/smithersai/smithers")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
}

test("real repository listings open files and switch the active repository", scenario("local-files-browse-switch", {
  capabilities: [],
  description: "Browses two disposable repositories through the real filesystem host and selects the intended repository.",
  coverage: ["action:repo.open", "action:repo.select", "action:files.list", "action:files.read", "host:local", "path:success", "path:keyboard", "door:slash", "door:button", "dimension:keyboard", "dimension:filesystem-browse", "dimension:repository-switch", "evidence:file-card-readback"]
}), async ({ page, request }) => {
  const alpha = await createOwnedLocalRepo({ name: "files-alpha", fixture: "none", files: { "README.md": "alpha repository marker\n", "src/a.ts": "export const alpha = 1\n" } })
  const beta = await createOwnedLocalRepo({ name: "files-beta", fixture: "none", files: { "README.md": "beta repository marker\n", "docs/guide.md": "# Beta guide\n" } })
  await boot(page)
  const alphaId = await openRepo(page, request, alpha)
  const betaId = await openRepo(page, request, beta)
  await runAndClose(page, `/repo.select local:${alpha.path}`)
  await runAndClose(page, "/files.list /")
  const listing = page.locator('.smithers-card[data-kind="file-list"]').last()
  await expect(listing).toContainText("README.md")
  await expect(listing).toContainText("src")
  const readmeButton = listing.getByRole("button", { name: "README.md", exact: true })
  await readmeButton.focus()
  await expect(readmeButton).toBeFocused()
  await readmeButton.press("Enter")
  await expect(fileCard(page, alphaId, "README.md")).toContainText("alpha repository marker")
  await runAndClose(page, `/repo.select local:${beta.path}`)
  await runAndClose(page, "/files.read README.md")
  await expect(fileCard(page, betaId, "README.md")).toContainText("beta repository marker")
  await expect(fileCard(page, alphaId, "README.md")).toBeVisible()
})

test("real file reads bound large text, suppress binary bytes, and report invalid paths", scenario("local-files-boundaries-errors", {
  capabilities: [],
  coverage: ["action:repo.open", "action:files.read", "host:local", "path:error", "door:slash", "dimension:large-file", "dimension:binary-file", "dimension:not-found", "evidence:visible-file-errors"]
}), async ({ page, request }) => {
  const repo = await createOwnedLocalRepo({ name: "files-boundaries", fixture: "none" })
  await writeRepoFiles(repo, {
    "large.txt": `${"large-line\n".repeat(4_000)}TAIL-MUST-BE-TRUNCATED\n`,
    "binary.bin": new Uint8Array([0, 255, 1, 2, 3, 4]),
    "src/item.ts": "export const item = true\n"
  })
  await boot(page)
  const id = await openRepo(page, request, repo)
  await runAndClose(page, "/files.read large.txt")
  const large = fileCard(page, id, "large.txt")
  await expect(large).toContainText("large-line")
  await expect(large).toContainText(/truncated/i)
  await expect(large).not.toContainText("TAIL-MUST-BE-TRUNCATED")
  await runAndClose(page, "/files.read binary.bin")
  await expect(fileCard(page, id, "binary.bin")).toContainText(/file is binary/i)
  await runAndClose(page, "/files.read missing.txt")
  await expect(page.getByText(/Path not found: missing\.txt/).last()).toBeVisible()
})

test("line anchors survive a real file revision and page reload", scenario("local-files-anchor-revision", {
  capabilities: [],
  coverage: ["action:repo.open", "action:files.read", "host:local", "path:success", "path:persistence", "door:slash", "dimension:line-anchor", "dimension:page-reload", "dimension:working-copy-revision", "evidence:filesystem-mutation-readback"]
}), async ({ page, request }) => {
  const repo = await createOwnedLocalRepo({ name: "files-revision", fixture: "none", files: { "src/revision.ts": "export const first = 1\nexport const second = 2\nexport const third = 3\n" } })
  await boot(page)
  const id = await openRepo(page, request, repo)
  await runAndClose(page, "/files.read src/revision.ts:2")
  const card = fileCard(page, id, "src/revision.ts")
  await expect(card.locator(".world-card-panel")).toHaveAttribute("data-line", "2")
  await expect(card.locator('[data-line="2"][data-selected-line]')).toHaveCount(1)
  await writeRepoFiles(repo, { "src/revision.ts": "export const first = 1\nexport const revised = 22\nexport const third = 3\n" })
  await runAndClose(page, "/files.read src/revision.ts:2")
  await expect(card).toContainText("export const revised = 22")
  await expect(card).not.toContainText("export const second = 2")
  await expect(card.locator('[data-line="2"][data-selected-line]')).toHaveCount(1)
  await page.reload()
  const restored = fileCard(page, id, "src/revision.ts")
  await expect(restored).toContainText("export const revised = 22")
  await expect(restored.locator(".world-card-panel")).toHaveAttribute("data-line", "2")
  await expect(restored.locator('[data-line="2"][data-selected-line]')).toHaveCount(1)
})

test("installed TypeScript language server powers hover, diagnostics, and definition navigation", scenario("local-code-intelligence-typescript", {
  capabilities: [],
  coverage: ["action:repo.open", "action:files.read", "action:code.hover", "action:code.diagnostics", "action:code.definition", "host:local", "path:success", "door:slash", "dimension:real-language-server", "dimension:hover", "dimension:diagnostics", "dimension:definition", "evidence:lsp-card-annotations"]
}), async ({ page, request }) => {
  const repo = await createOwnedLocalRepo({ name: "code-intelligence", fixture: "none", files: {
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true, types: [] }, include: ["src"] }),
    "src/greet.ts": "export interface Greeting { readonly name: string }\nexport const greet = (value: Greeting): string => `hello ${value.name}`\n",
    "src/index.ts": "import { greet } from \"./greet\"\nconst message = greet({ name: \"Smithers\" })\nexport const broken = message.lenght\n"
  } })
  const require = createRequire(__filename)
  await mkdir(join(repo.path, "node_modules"), { recursive: true })
  await symlink(dirname(require.resolve("typescript/package.json")), join(repo.path, "node_modules", "typescript"))
  await boot(page)
  const id = await openRepo(page, request, repo)
  await runAndClose(page, "/files.read src/index.ts")
  const source = fileCard(page, id, "src/index.ts")
  await expect(source.locator('[data-slot="code-view"]')).toHaveAttribute("data-state", "ready", { timeout: 30_000 })
  await runAndClose(page, "/code.hover src/index.ts:2:17")
  await expect(source.locator('[data-slot="code-hover"]')).toContainText("greet", { timeout: 60_000 })
  let diagnostic = source.locator('[data-slot="code-diagnostic"][data-severity="error"]').filter({ hasText: "Property 'lenght' does not exist on type 'string'." })
  const deadline = Date.now() + 20_000
  while (await diagnostic.count() === 0 && Date.now() < deadline) {
    await runAndClose(page, "/code.diagnostics src/index.ts")
  }
  await expect(diagnostic).toContainText("Property 'lenght' does not exist on type 'string'. Did you mean 'length'?")
  await expect(diagnostic).toContainText("typescript 2551")
  expect(await diagnostic.evaluate((node) => node.closest("[slot]")?.getAttribute("slot"))).toBe("annotation-3")
  await runAndClose(page, "/code.definition src/index.ts:2:17")
  const target = fileCard(page, id, "src/greet.ts")
  await expect(target).toBeVisible({ timeout: 60_000 })
  await expect(target.locator(".world-card-panel")).toHaveAttribute("data-line", "2")
  await expect(target).toContainText("export const greet")
  await writeRepoFiles(repo, { "src/index.ts": "import { greet } from \"./greet\"\nconst message = greet({ name: \"Smithers\" })\nexport const fixed = message.length\n" })
  const clearDeadline = Date.now() + 20_000
  while (await source.locator('[data-slot="code-diagnostics-count"]').textContent() !== "0 errors · 0 warnings" && Date.now() < clearDeadline) {
    await runAndClose(page, "/code.diagnostics src/index.ts")
  }
  await expect(source.locator('[data-slot="code-diagnostics-count"]')).toHaveText("0 errors · 0 warnings")
  await expect(source.locator('[data-slot="code-diagnostic"]')).toHaveCount(0)
  await expect(source).toContainText("export const fixed = message.length")
})
