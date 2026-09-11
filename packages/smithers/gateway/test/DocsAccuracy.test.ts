/**
 * Prose claims in the package docs, pinned to the code they describe.
 *
 * Each of these drifted from the implementation: the docs named a third peer
 * the manifest never declared, allowed any loopback Origin when ingress
 * requires the Origin to equal the request authority, and said a
 * `Projection.Snapshot` request streams once it is sent over the socket.
 */
import * as Fs from "node:fs"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const packageRoot = Path.join(Path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (file: string): string => Fs.readFileSync(Path.join(packageRoot, file), "utf8")

/** README.md plus every Markdown file under docs/, relative to the package. */
const docSources = (): ReadonlyArray<string> => [
  "README.md",
  ...(Fs.readdirSync(Path.join(packageRoot, "docs"), { recursive: true }) as Array<string>)
    .filter((file) => /\.mdx?$/.test(file))
    .map((file) => Path.join("docs", file))
]

/** The first prose paragraph of a Markdown file, past frontmatter and headings, on one line. */
const leadParagraph = (file: string): string =>
  (read(file).replace(/^---\n[\s\S]*?\n---\n/, "").trim().split("\n\n").find((block) => !block.startsWith("#")) ??
    "").replaceAll("\n", " ")

describe("the package docs", () => {
  const manifest = JSON.parse(read("package.json")) as {
    readonly peerDependencies: Record<string, string>
    readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>
  }
  const peers = Object.keys(manifest.peerDependencies).sort()

  it.each(["README.md", "docs/api.md"])("%s names exactly the declared peers", (file) => {
    const lead = leadParagraph(file)
    const named = [...lead.matchAll(/`(@?[\w./-]+)`/g)].map((match) => match[1] as string)
      .filter((name) => name === "effect" || name.startsWith("@effect/"))
    expect([...new Set(named)].sort()).toEqual(peers)
    for (const [peer, meta] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
      if (meta.optional === true) expect(lead).toMatch(new RegExp(`\`${peer}\`[^.]*optional`))
    }
  })

  it.each(["README.md", "docs/README.md", "docs/api.md", "docs/troubleshooting.md", "docs/concepts/trust-boundary.md"])(
    "%s requires the Origin to match the request authority",
    (file) => {
      const prose = read(file).replaceAll(/\s+/g, " ")
      // The stale rule: any HTTP(S) Origin on a loopback name is accepted.
      expect(prose).not.toMatch(/Origin`? (?:must|that is not) (?:use|name|be|HTTP)[^.]*`?localhost`?, `?127\.0\.0\.1/)
      expect(prose).not.toContain("served from a loopback origin")
      expect(prose).toMatch(/Origin[^.]*(?:host and port|hostname and port)[^.]*(?:request|`Host`)/)
    }
  )

  it("follows a run over the socket with Projection.Subscribe", () => {
    const overview = read("docs/README.md").replaceAll(/\s+/g, " ")
    expect(overview).not.toContain("The same request on `/projections/ws`")
    expect(overview).toMatch(
      /Projection\.Subscribe[^.]*`\/projections\/ws`|`\/projections\/ws`[^.]*Projection\.Subscribe/
    )
  })

  it.each(docSources())("%s contains no em-dash", (file) => {
    expect(read(file)).not.toContain("—")
  })
})
