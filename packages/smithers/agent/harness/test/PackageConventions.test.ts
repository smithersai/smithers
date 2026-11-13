import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, matchesGlob, posix } from "node:path"
import { describe, expect, it } from "vitest"
import * as Sandbox from "../src/Sandbox.ts"

const srcDir = join(import.meta.dirname, "..", "src")

const sources = (dir: string, prefix = ""): ReadonlyArray<readonly [string, string]> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name), `${prefix}${entry.name}/`)
      : entry.name.endsWith(".ts")
      ? [[`${prefix}${entry.name}`, readFileSync(join(dir, entry.name), "utf8")] as const]
      : []
  )

const src = sources(srcDir)

const owning = (pattern: RegExp): ReadonlyArray<string> =>
  src.filter(([, text]) => pattern.test(text)).map(([name]) => name)

describe("package conventions", () => {
  // Six modules each declared this validator; they agreed only by hand.
  it("declares the non-negative safe integer validator once", () => {
    expect(
      owning(
        /Schema\.Int\.check\(\s*\n?\s*Schema\.isGreaterThanOrEqualTo\(0\),\s*\n?\s*Schema\.isLessThanOrEqualTo\(Number\.MAX_SAFE_INTEGER\)/
      )
    ).toEqual([
      "internal/nonNegativeSafeInt.ts"
    ])
  })

  // Two private `refused` helpers plus ten inline copies of one literal shape.
  it("constructs a refusal call result in one place", () => {
    expect(owning(/(?:Cell\.)?CallResult\.new\(\{\s*\n?\s*outcome: "failure"/)).toEqual([
      "internal/refusal.ts"
    ])
  })

  // ContextWindow kept a private copy and Compaction wrote its own.
  it("selects compactable segments in one place", () => {
    expect(owning(/kind === "transcript" \|\| segment\.kind === "summary"/)).toEqual([
      "internal/compactable.ts"
    ])
  })

  // Compaction verified the declared digest twice, with the noun as the only difference.
  it("verifies a declared compaction prefix in one place", () => {
    const compaction = src.find(([name]) => name === "Compaction.ts")?.[1] ?? ""
    expect(compaction.match(/step\.replacedPrefixDigest/g)?.length).toBe(1)
  })

  // Service tags are runtime keys, never journaled, so they carry the package name.
  it("tags every context service with the package name", () => {
    const tags = src.flatMap(([, text]) => [...text.matchAll(/Context\.Service(?:<[^>]*>\(\))?\(\s*\n?\s*"([^"]+)"/g)])
      .map((match) => match[1] ?? "")
    expect(tags.length).toBeGreaterThan(0)
    expect(tags.filter((tag) => !tag.startsWith("@smthrs/harness/"))).toEqual([])
  })

  // The package ships 1.0.0-rc.0; nothing in it was released as 1.0.0.
  it("claims no unreleased version in an @since tag", () => {
    expect(owning(/@since 1\.0\.0[ \t]*$/m)).toEqual([])
  })

  // Every other module names its defaults in camelCase.
  it("names module-level constants in camelCase", () => {
    expect(owning(/^const [A-Z0-9_]{2,} =/m)).toEqual([])
  })

  // CellTurn kept a copy of `bounded`'s docblock stacked on `missedProperty`'s,
  // and QuickJSSandbox kept one for a prelude it no longer has. A block with
  // another block directly after it documents nothing, and reads as the
  // description of whatever it happens to sit above. A module header is the
  // exception: it documents the file, and the block after it is the first
  // declaration's.
  it("attaches every docblock to the declaration after it", () => {
    const stacked = src.flatMap(([name, text]) =>
      [...text.matchAll(/\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*\/\*\*/g)]
        .filter((match) => text.slice(0, match.index).trim() !== "")
        .map((match) => `${name}:${text.slice(0, match.index).split("\n").length}`)
    )
    expect(stacked).toEqual([])
  })

  it("documents the default per-call ceiling", () => {
    const readme = readFileSync(join(srcDir, "..", "README.md"), "utf8")
    const seconds = readme.match(/a (\d+)-second ceiling on any one flow call/)?.[1]
    expect(Number(seconds) * 1000).toBe(Sandbox.defaultLimits.callMs)
  })

  it("documents every root-only namespace", () => {
    const root = join(srcDir, "..")
    const readme = readFileSync(join(root, "README.md"), "utf8")
    const { exports } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    const index = readFileSync(join(srcDir, "index.ts"), "utf8")
    const rootOnly = [...index.matchAll(/export \* as (\w+) from/g)]
      .map((match) => match[1]!)
      .filter((name) => !exports[`./${name}`])
    const exceptions = readme.match(/except (.+?), which are on the root only/)?.[1] ?? ""
    const documented = [...exceptions.matchAll(/`(\w+)`/g)].map((match) => match[1]!)
    expect(documented.sort()).toEqual(rootOnly.sort())
  })

  it("links README repository examples to existing files", () => {
    const root = join(srcDir, "..", "../../../..")
    const readme = readFileSync(join(srcDir, "..", "README.md"), "utf8")
    const links = [...readme.matchAll(/\]\(https:\/\/github\.com\/smithersai\/smithers\/blob\/main\/([^ )#]+)\b/g)]
      .map((match) => match[1]!)
    expect(links.length).toBeGreaterThan(0)
    expect(links.filter((target) => !existsSync(join(root, target)))).toEqual([])
  })

  // The allowlist once read `docs/*.md`, so the four guides linked from
  // docs/README.md and HISTORY.md linked from the changelog never shipped.
  it("ships every file a shipped markdown page links to", () => {
    const root = join(import.meta.dirname, "..")
    const { files } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files: ReadonlyArray<string> }
    const shipped = (file: string) =>
      files.some((pattern) => matchesGlob(file, pattern) || pattern.endsWith("/") && file.startsWith(pattern))
    const markdown = (dir: string): ReadonlyArray<string> =>
      readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? markdown(`${dir}/${entry.name}`)
          : entry.name.endsWith(".md")
          ? [`${dir}/${entry.name}`]
          : []
      )
    const pages = ["README.md", "CHANGELOG.md", ...markdown("docs")].filter(shipped)
    const broken = pages.flatMap((page) =>
      [...readFileSync(join(root, page), "utf8").matchAll(/\]\((?!https?:|mailto:|#|\/)([^)#\s]+)/g)]
        .map((match) => posix.normalize(posix.join(posix.dirname(page), match[1] ?? "")))
        .filter((target) => !existsSync(join(root, target)) || !shipped(target))
        .map((target) => `${page} -> ${target}`)
    )
    expect(pages).toContain("docs/README.md")
    expect(broken).toEqual([])
  })
})
