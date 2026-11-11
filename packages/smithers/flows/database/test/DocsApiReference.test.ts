import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

/**
 * The parameters of a source declaration, names dropped. The reference page
 * is free to rename a parameter, so only the type and its optionality are
 * compared. No documented parameter list carries a comma inside a type
 * argument, so splitting on the comma is enough.
 */
const declared = (source: string, name: string): ReadonlyArray<string> => {
  const list = source.match(new RegExp(`export const ${name} = \\(([^)]*)\\)`, "u"))?.[1]
  expect(list, `src declares ${name}`).toBeDefined()
  return list!.split(",")
    .map((parameter) => parameter.trim())
    .filter((parameter) => parameter.length > 0)
    .map((parameter) => parameter.replace(/^\w+/u, ""))
}

/** The fenced signature under `### <name>` on the reference page. */
const documented = (page: string, name: string): string => {
  const fence = page.split(`\n### ${name}\n`)[1]?.split("```")[1]
  expect(fence, `docs/api.md documents ${name}`).toBeDefined()
  return fence!.replace(/^ts\n/u, "").trim()
}

// The reference page is what a store author copies from. It listed
// afterCommit with one parameter, hiding the owning client that stops a
// nested write to another database from publishing this database's update.
describe("docs/api.md", () => {
  it("documents every afterCommit parameter", () => {
    const signature = documented(read("../docs/api.md"), "afterCommit")
    const parameters = declared(read("../src/internal/CommitScope.ts"), "afterCommit")
    expect(parameters.length).toBe(2)
    for (const parameter of parameters) expect(signature).toContain(parameter)
  })

  it("documents every afterRollback parameter", () => {
    const signature = documented(read("../docs/api.md"), "afterRollback")
    const parameters = declared(read("../src/internal/CommitScope.ts"), "afterRollback")
    expect(parameters.length).toBe(2)
    for (const parameter of parameters) expect(signature).toContain(parameter)
  })

  // `Metric.Counter` needs its input type argument, so the bare name does not
  // compile when it is copied out of the page.
  it("documents the retry counter with its input type", () => {
    expect(documented(read("../docs/api.md"), "writeRetries")).toBe(
      "const writeRetries: Metric.Counter<number>"
    )
  })
})
