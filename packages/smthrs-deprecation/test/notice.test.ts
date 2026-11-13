import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { fences, notice } from "./golden.ts"

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

describe("the notice this package throws", () => {
  it("is the frozen four-line text, not a message that merely mentions the parts", async () => {
    const failure = await import("../src/index.ts").then(
      () => undefined,
      (error: unknown) => error as Error
    )

    expect(failure).toBeInstanceOf(Error)
    expect(failure?.message).toBe(notice)
  })

  it("is quoted verbatim by the README npm publishes", () => {
    expect(fences(read("../README.md"))[0]).toBe(notice)
  })

  it("is quoted verbatim by the package-owned documentation fragment", () => {
    expect(fences(read("../docs/notice.md"))[0]).toBe(notice)
  })
})

describe("what the published docs say about installing 1.0", () => {
  // The README npm publishes said "Not on npm yet" through rc.5, while
  // `smthrs@next` and `@smthrs/cli@next` were installable (#3845). The
  // manifest's publish tag is the fact; every published page follows it.
  const pages = ["../README.md", "../docs/README.md", "../docs/notice.md", "../docs/troubleshooting.md"]
  const tag = (JSON.parse(read("../package.json")) as { publishConfig: { tag: string } }).publishConfig.tag

  it("documents Node, Bun and native executables as TUI alternatives", () => {
    const introduction = read("../README.md").split("\n\n").find((paragraph) => paragraph.includes("`npx smthrs tui`"))

    expect(introduction).toContain("Node 26.4 or later")
    expect(introduction).toContain("[Bun](https://bun.sh)")
    expect(introduction).toContain("native TUI executable")
    expect(introduction).not.toMatch(/requires \[Bun\]/)
  })

  it("never tells a reader the packages are missing from npm", () => {
    for (const page of pages) {
      expect(read(page), page).not.toMatch(/not on npm|not (?:yet )?published|installable notice yet/i)
    }
  })

  it("installs the CLI and the migration from the tag the package publishes under", () => {
    expect(tag).toBe("next")
    for (const page of ["../README.md", "../docs/README.md"]) {
      const text = read(page)
      expect(text, page).toContain(`npx smthrs@${tag} migrate`)
      expect(text, page).toContain(`npm install @smthrs/flows@${tag} @smthrs/cli@${tag}`)
    }
  })
})
