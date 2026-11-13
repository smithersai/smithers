import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { JjErrorCode } from "../src/Jj.ts"
import { overrideVariables } from "../src/node/resolveJjBinary.ts"

const read = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), "utf8")

/** Every narrative page that states the error vocabulary rather than referring to it. */
const vocabularyPages = ["README.md", "docs/README.md", "docs/concepts/failures.md", "docs/troubleshooting.md"]

/** Every page a reader can reach without leaving the package. */
const packagePages = [
  ...vocabularyPages,
  "CHANGELOG.md",
  "docs/api.md",
  "docs/installation.md",
  "docs/quickstart.md",
  "docs/concepts/version-control-as-a-capability.md",
  "docs/guides/bind-and-contain.md",
  "docs/guides/choose-the-jj-binary.md",
  "docs/guides/run-jj-in-a-browser.md",
  "docs/guides/snapshot-and-restore.md",
  "docs/guides/testing.md",
  "docs/guides/workspace-lanes.md"
]

describe("revert documentation", () => {
  it.each(["testing", "run-jj-in-a-browser"])("%s never probes support by reverting", (guide) => {
    const markdown = read(`docs/guides/${guide}.md`)
    const sections = markdown.split(/(?=^#{1,6} )/m)

    for (const section of sections) {
      if (!/capability[- ](?:detect|check)|feature[- ]detect|canRevert/i.test(section)) continue
      expect(section).not.toMatch(/\.revert\s*[!?]?\s*\(/)
      expect(section).not.toMatch(/\bcall\s+`revert`/i)
      expect(section).not.toContain("canRevert")
    }
  })
})

describe("error code documentation", () => {
  it.each(vocabularyPages)("%s names every JjErrorCode", (page) => {
    const markdown = read(page)
    for (const code of JjErrorCode.literals) expect(markdown).toContain(`\`${code}\``)
  })

  it.each(packagePages)("%s counts the vocabulary as the schema does", (page) => {
    const spelled = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
    const wrong = spelled.filter((_, count) => count !== JjErrorCode.literals.length)
    expect(read(page)).not.toMatch(new RegExp(`\\b(?:${wrong.join("|")})\\b\\s+(?:JjError\\s+)?codes\\b`, "i"))
  })
})

describe("version probe documentation", () => {
  /** Every page that says when a CLI layer checks the jj version. */
  const probePages = [
    "README.md",
    "docs/README.md",
    "docs/api.md",
    "docs/concepts/failures.md",
    "docs/troubleshooting.md",
    "docs/guides/choose-the-jj-binary.md"
  ]

  it.each(probePages)("%s places the version probe on the first operation, not on the layer build", (page) => {
    const markdown = read(page)
    expect(markdown).toMatch(/first operation/)
    expect(markdown).not.toMatch(
      /fails? construction|fails? a CLI layer|never reaches an operation|before (?:it )?expos(?:es|ing) `Jj`|Layer<Jj, JjError/
    )
    expect(markdown).not.toMatch(/(?:layer|construction) error channel/)
  })
})

describe("binary override documentation", () => {
  /** A variable the resolver never reads may be named only to send a reader off it. */
  const migration = /migrat|no longer|never read|not read|is not an alias/i

  it.each(packagePages)("%s presents only supported override variables", (page) => {
    for (const paragraph of read(page).split(/\n\s*\n/)) {
      for (const [, variable] of paragraph.matchAll(/\b([A-Z][A-Z0-9_]*_JJ_PATH)\b/g)) {
        if (overrideVariables.includes(variable!)) continue
        expect(paragraph).toMatch(migration)
      }
    }
  })
})

describe("browser documentation", () => {
  it("README never promises initialization on every browser operation", () => {
    expect(read("README.md")).not.toMatch(/auto-initializ/i)
  })

  it("README keeps browser behavior out of the license section", () => {
    const license = read("README.md").split(/^## License$/m)[1]
    expect(license).toBeDefined()
    expect(license).not.toContain("BrowserJj")
  })
})
