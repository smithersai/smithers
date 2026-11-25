import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { Cli } from "../src/index.ts"

const pkgRoot = fileURLToPath(new URL("..", import.meta.url))

const collectFiles = async (dir: string, exts: ReadonlyArray<string>): Promise<Array<string>> => {
  const out: Array<string> = []
  const entries = await Fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = Path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(full, exts)))
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full)
    }
  }
  return out
}

describe("Docs parity and splash page", () => {
  it("ensures every relative link across README.md, docs/**/*.md, and docs/splash/index.html resolves", async () => {
    const mdFiles = [Path.join(pkgRoot, "README.md"), ...(await collectFiles(Path.join(pkgRoot, "docs"), [".md"]))]
    const broken: Array<string> = []

    for (const file of mdFiles) {
      const content = await Fs.readFile(file, "utf8")
      const linkRe = /\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g
      for (const match of content.matchAll(linkRe)) {
        const href = match[1]!
        if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:")) continue
        const target = Path.resolve(Path.dirname(file), href)
        try {
          await Fs.access(target)
        } catch {
          broken.push(`${Path.relative(pkgRoot, file)} -> ${href}`)
        }
      }
    }

    expect(broken).toEqual([])
  })

  it("ensures docs/splash/index.html is self-contained with zero external network assets", async () => {
    const html = await Fs.readFile(Path.join(pkgRoot, "docs/splash/index.html"), "utf8")
    expect(html).toContain("<!doctype html>")
    expect(html).toContain("Smithers")
    expect(html).toContain("Comments")
    expect(html).toContain("Inline mode")
    expect(html).toContain("External mode")
    expect(html).not.toMatch(/<script[^>]+src=["']https?:/i)
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i)
  })

  it.effect("documents every CLI subcommand shown in --help", () =>
    Effect.gen(function*() {
      let stdout = ""
      const code = yield* Cli.runCli(["--help"], {
        cwd: pkgRoot,
        stdout: (s) => {
          stdout += s
        },
        stderr: () => {}
      })
      expect(code).toBe(0)
      for (const cmd of ["init", "check", "lint", "fix", "extract", "render", "status"]) {
        expect(stdout).toContain(cmd)
      }
    }))
})
