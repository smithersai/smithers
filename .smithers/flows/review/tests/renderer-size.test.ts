import { describe, expect, test } from "bun:test"
import { build } from "esbuild"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { gunzipSync } from "node:zlib"
import { chromium } from "playwright"
import { renderPierreFileDiff } from "../src/diffs/renderPierreFileDiff.ts"
import { mermaidRuntimeGzipBase64 } from "../src/walkthrough/mermaidRuntimeGzipBase64.ts"
import { renderWalkthroughHtml } from "../src/walkthrough/renderWalkthroughHtml.ts"

function patch(path: string, before: string, after: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`
}

describe("the offline review renderer budget (#4331)", () => {
  test("bundles a lazy, self-contained renderer below 2.5 MiB without the full Shiki catalog", async () => {
    const result = await build({
      entryPoints: [new URL("../src/walkthrough/renderWalkthroughHtml.ts", import.meta.url).pathname],
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      format: "esm"
    })
    expect(result.outputFiles).toHaveLength(1)
    expect(result.outputFiles[0]!.contents.byteLength).toBeLessThan(2.5 * 1024 * 1024)
    const inputs = Object.keys(result.metafile!.inputs)
    expect(inputs.filter((path) => path.includes("@shikijs/langs/") || path.includes("@shikijs/themes/"))).toEqual([])
    // No package or CDN import may be needed by the deployed renderer.
    expect(
      Object.values(result.metafile!.outputs).flatMap((output) => output.imports)
        .filter((entry) => !entry.path.startsWith("node:"))
    ).toEqual([])
    // Execute the single deployed module too: source-mode resolution cannot
    // accidentally satisfy a dependency omitted from the packaged runtime.
    const directory = await mkdtemp(join(tmpdir(), "smithers-review-renderer-"))
    try {
      const file = join(directory, "renderer.mjs")
      await writeFile(file, result.outputFiles[0]!.contents)
      const bundled = await import(pathToFileURL(file).href) as {
        renderWalkthroughHtml: typeof renderWalkthroughHtml
      }
      const diff = patch("src/bundled.ts", "const value = 1", "const value = 2")
      const html = await bundled.renderWalkthroughHtml({
        title: "Bundled",
        story: { headline: "Bundled", synopsis: "", chapters: [] },
        files: [{
          path: "src/bundled.ts",
          status: "modified",
          insertions: 1,
          deletions: 1,
          diff,
          reviewed: true,
          excludeReason: ""
        }],
        comments: [],
        repoDir: "/repo",
        mode: "workspace",
        ref: "workspace",
        generatedAt: "2026-11-05T00:00:00Z"
      })
      expect(html).toContain("data-dehydrated")
      expect(html).toContain("--diffs-token-light")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("keeps highlighted code, word diffs, annotations, and readable uncommon languages", async () => {
    const highlighted = await renderPierreFileDiff({
      diff: patch("src/example.ts", "const count = 1", "const count = 2"),
      annotations: [{ side: "additions", lineNumber: 1 }]
    })
    expect(highlighted).toContain("--diffs-token-light")
    expect(highlighted).toContain("--diffs-token-dark")
    expect(highlighted).toContain("data-diff-span")
    expect(highlighted).toContain("name=\"annotation-additions-1\"")
    const uncommon = await renderPierreFileDiff({ diff: patch("notes.el", "(old)", "(new)") })
    expect(uncommon.replace(/<[^>]*>/g, "")).toContain("(new)")
    expect(uncommon).toContain("data-line-type=\"change-addition\"")
    const split = await renderPierreFileDiff({ diff: patch("src/a.ts", "let a = 1", "let a = 2"), diffStyle: "split" })
    expect(split).toContain("data-diff-type=\"split\"")
  })

  for (
    const [path, before, after] of [
      ["src/a.tsx", "<div>old</div>", "<div>new</div>"],
      ["src/a.js", "const value = 1", "const value = 2"],
      ["src/a.jsx", "<div>old</div>", "<div>new</div>"],
      ["config.json", "{\"value\":1}", "{\"value\":2}"],
      ["config.jsonc", "{\"value\":1}", "{\"value\":2}"],
      ["style.css", "a { color: red }", "a { color: blue }"],
      ["index.html", "<b>old</b>", "<b>new</b>"],
      ["README.md", "# Old", "# New"],
      ["config.yaml", "value: 1", "value: 2"],
      ["config.toml", "value = 1", "value = 2"],
      ["run.sh", "echo old", "echo new"],
      ["run.zsh", "echo old", "echo new"],
      ["query.sql", "SELECT 1", "SELECT 2"],
      ["main.go", "var value = 1", "var value = 2"],
      ["main.rs", "let value = 1;", "let value = 2;"],
      ["main.py", "value = 1", "value = 2"],
      ["main.c", "int value = 1;", "int value = 2;"],
      ["main.cpp", "int value = 1;", "int value = 2;"],
      ["Main.cs", "int value = 1;", "int value = 2;"],
      ["Main.java", "int value = 1;", "int value = 2;"],
      ["Dockerfile", "FROM node:25", "FROM node:26"],
      ["change.diff", "+old", "+new"],
      ["file.xml", "<b>old</b>", "<b>new</b>"],
      ["Page.vue", "<template>old</template>", "<template>new</template>"],
      ["Page.svelte", "<b>old</b>", "<b>new</b>"]
    ] as const
  ) {
    test(`highlights ${path} from its pinned grammar offline`, async () => {
      const html = await renderPierreFileDiff({ diff: patch(path, before, after) })
      expect(html).toContain("--diffs-token-light")
      expect(html).toContain("--diffs-token-dark")
      expect(html).toContain("data-line-type=\"change-addition\"")
      expect(html).toContain("data-line-type=\"change-deletion\"")
    })
  }

  test("renders diagrams and diffs in Chromium with the network offline", async () => {
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] })
    try {
      const context = await browser.newContext({ offline: true })
      const page = await context.newPage()
      const errors: string[] = []
      const requests: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("request", (request) => requests.push(request.url()))
      const diagrams = ["graph TD; A-->B", "sequenceDiagram\nAlice->>Bob: Hello", "stateDiagram-v2\n[*] --> Ready"]
      const diff = patch("src/offline.ts", "const count = 1", "const count = 2")
      const html = await renderWalkthroughHtml({
        title: "Offline",
        story: {
          headline: "Offline",
          synopsis: "",
          chapters: [{
            title: "Changes",
            blocks: [
              ...diagrams.map((mermaid) => ({ kind: "diagram", text: "", path: "", intro: "", title: "", mermaid })),
              { kind: "diff", text: "", path: "src/offline.ts", intro: "", title: "", mermaid: "" }
            ]
          }]
        },
        files: [{
          path: "src/offline.ts",
          status: "modified",
          insertions: 1,
          deletions: 1,
          diff,
          reviewed: true,
          excludeReason: ""
        }],
        comments: [],
        repoDir: "/repo",
        mode: "workspace",
        ref: "workspace",
        generatedAt: "2026-11-05T00:00:00Z"
      })
      await page.setContent(html)
      await page.waitForFunction(() =>
        document.querySelectorAll("pre.mermaid svg").length === 3 || document.querySelector(".diagram-note") !== null
      )
      expect(await page.locator("pre.mermaid svg").count()).toBe(3)
      expect(await page.locator(".pierre-diff [data-line-type='change-addition']").count()).toBeGreaterThan(0)
      expect(await page.locator(".pierre-diff [style*='--diffs-token-light']").count()).toBeGreaterThan(0)
      const firstIds = await page.locator("pre.mermaid svg").evaluateAll((nodes) =>
        nodes.map((node) => node.id).join(",")
      )
      await page.locator("#theme-toggle").click()
      await page.waitForFunction((previous) => {
        const nodes = Array.from(document.querySelectorAll("pre.mermaid svg"))
        return nodes.length === 3 && nodes.map((node) => node.id).join(",") !== previous
      }, firstIds)
      expect(errors).toEqual([])
      expect(requests).toEqual([])
    } finally {
      await browser.close()
    }
  })

  test("embeds exactly one offline Mermaid runtime for several diagrams and none for prose", async () => {
    const diagram = { kind: "diagram", text: "", path: "", intro: "", title: "Flow", mermaid: "graph TD; A-->B" }
    const input = {
      title: "Size regression",
      story: { headline: "Flow", synopsis: "", chapters: [{ title: "Changes", blocks: [diagram, diagram] }] },
      files: [],
      comments: [],
      repoDir: "/repo",
      mode: "workspace",
      ref: "workspace",
      generatedAt: "2026-11-05T00:00:00Z"
    }
    const html = await renderWalkthroughHtml(input)
    const runtime = mermaidRuntimeGzipBase64()
    expect(html.split(runtime)).toHaveLength(2)
    expect(html.match(/id="mermaid-runtime-gz"/g)).toHaveLength(1)
    expect(html.match(/<pre class="mermaid">/g)).toHaveLength(2)
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(gunzipSync(Buffer.from(runtime, "base64")).toString()).toContain("mermaid")
    const plain = await renderWalkthroughHtml({ ...input, story: { ...input.story, chapters: [] } })
    expect(plain).not.toContain(runtime)
  })
})
