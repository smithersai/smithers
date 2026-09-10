import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/g, " ")

it.each(["../README.md", "../docs/api.md", "../CHANGELOG.md"])(
  "%s documents the shipped CLI and unified MCP access",
  (path) => {
    const text = read(path)
    expect(text).toContain("`smthrs runs inspect|replay|fork|rewind`")
    expect(text).toContain("https://smithers.sh/docs/reference/cli/")
    expect(text).toMatch(/MCP[^.]*only through the unified command tools/)
    expect(text).not.toMatch(/no (?:time-travel|CLI) verb|only a library API|`smithers` command-line/)
  }
)

it("documents the current documentation sync pipeline", () => {
  const text = read("../CHANGELOG.md")
  expect(text).not.toMatch(/docs\/Manifest\.ts|scripts\/docs\.mjs|docs\/pages\//)
  expect(text).toContain("contentSync")
  expect(text).toContain("apps/site/scripts/sync-api-docs.mjs")
})

const readRaw = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

it("names every public root export in the README table and the API reference", () => {
  const readme = read("../README.md")
  const api = read("../docs/api.md")
  for (
    const name of [
      "ReadOnlyTimeTravel",
      "readOnly",
      "forkWorkspaceName",
      "Position",
      "retainWorkspace",
      "engineEvents"
    ]
  ) {
    expect(readme, `README.md omits ${name}`).toContain(name)
    expect(api, `docs/api.md omits ${name}`).toContain(name)
  }
})

it("documents ReplayOptions.engineEvents and that inspect cannot supply it", () => {
  const api = read("../docs/api.md")
  expect(api).toContain("readonly engineEvents?: EngineEvent.Consumer | undefined")
  expect(api).toMatch(/versioned engine[^.]*only through `replay`|`inspect` takes no options/)
})

it("keeps the runtime requirement in its own README paragraph", () => {
  expect(readRaw("../README.md")).toMatch(/\n\nNode\.js 22\.19\.0 or later\./)
})

it("states the fork replay limitation once, and links the other pages to it", () => {
  const guide = readRaw("../docs/guides/fork-a-run.md")
  const readme = readRaw("../README.md")
  const anchor = "guides/fork-a-run/#keep-sealed-steps-from-re-executing"

  expect(guide.match(/copied attempt rows retain their parent digests/g)).toHaveLength(1)
  expect(readme.match(/copied attempt rows retain their parent digests/g)).toHaveLength(1)
  expect(readme).not.toContain("Make repeated external effects idempotent")
  expect(readme).toContain(anchor)
})

it("tells a handler author that receipts persist unredacted and must not carry credentials", () => {
  const guide = read("../docs/guides/compensate-an-effect.md")
  expect(guide).toContain("without the redaction pass")
  expect(guide).toContain("A receipt must never carry a credential.")
})
