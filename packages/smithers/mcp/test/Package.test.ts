import * as ChildProcessEnvironment from "@smthrs/kernel/ChildProcessEnvironment"
import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("package manifest and README", () => {
  it("points the README at the published documentation instead of the source tree", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")

    // npm renders this file, so every reference has to resolve for a reader who
    // has only the tarball. A relative `docs/` path does not: npm's README view
    // resolves it against the registry page, not the shipped `docs/` tree.
    expect(readme).toContain("https://github.com/smithersai/smithers/tree/main/packages/smithers/mcp/docs")
    expect(readme).not.toMatch(/\]\(\.\/docs\//)

    // The package is on npm under `next`, which carries the 1.0 release
    // candidates; `latest` is older, so the README names the tag.
    expect(readme).toContain("npm install @smthrs/mcp@next")
    expect(readme).not.toMatch(/not (?:yet )?(?:on|published to) npm|not on npm yet/i)

    // The links a reader without the repository can still follow.
    for (const path of [new URL("../LICENSE", import.meta.url)]) {
      expect(existsSync(path)).toBe(true)
    }

    expect(readme.match(/^## .+$/gm)?.at(-1)).toBe("## License")
    expect(readme.trim().split("## License\n").at(-1)?.trim()).toBe("MIT. See [LICENSE](./LICENSE).")
    expect(readme.slice(0, readme.indexOf("## License"))).toContain("`maxStderrBytes` (2048 by default)")
  })

  it.each([
    "../README.md",
    "../docs/guides/connect-a-server.md",
    "../docs/guides/configure-servers-for-the-cli.md"
  ])("separates locked server installation from credentials in %s", (path) => {
    const document = readFileSync(new URL(path, import.meta.url), "utf8")
    expect(document).not.toMatch(/npx(?: -y|["']\s*,)/)

    const installRecipe = (text: string) =>
      [...text.matchAll(/```bash\n([\s\S]*?)```/g)].find((match) =>
        match[1]?.includes("@modelcontextprotocol/server-github")
      )?.[1]
    const recipe = installRecipe(document)
    expect(recipe).toBeDefined()
    expect(recipe).toContain(
      "--package-lock-only --ignore-scripts --save-exact @modelcontextprotocol/server-github@2025.4.8"
    )
    expect(recipe).toContain("npm ci --prefix /path/to/mcp-servers --ignore-scripts")
    const commands = recipe?.split("\n").filter((line) => line.includes("npm ")) ?? []
    expect(commands).toHaveLength(2)
    for (const command of commands) {
      expect(command).toMatch(/^env -u GITHUB_TOKEN -u GITHUB_PERSONAL_ACCESS_TOKEN npm /)
    }
    expect(recipe).toBe(installRecipe(readFileSync(new URL("../README.md", import.meta.url), "utf8")))
    expect(document).toMatch(/command"?: "\/path\/to\/mcp-servers\/node_modules\/\.bin\/mcp-server-github"/)
    expect(document).toMatch(/args"?: \[\]/)
    expect(document).toMatch(
      /env"?: \{ GITHUB_PERSONAL_ACCESS_TOKEN: process\.env\.GITHUB_TOKEN \}|envFrom": \{ "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_TOKEN" \}/
    )
  })

  it.each([
    "../README.md",
    "../docs/guides/connect-a-server.md",
    "../docs/guides/configure-servers-for-the-cli.md"
  ])("never writes a credential by value into a persisted server entry in %s", (path) => {
    const document = readFileSync(new URL(path, import.meta.url), "utf8")
    expect(document).not.toMatch(/ghp_/)
    const files = [...document.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]!) as unknown)
    for (const entries of files) {
      expect(Array.isArray(entries)).toBe(true)
      for (const entry of entries as ReadonlyArray<{ readonly env?: Record<string, string> }>) {
        for (const name of Object.keys(entry.env ?? {})) {
          expect(ChildProcessEnvironment.isCredentialName(name), `${name} is held by value in ${path}`).toBe(false)
        }
      }
    }
  })

  it("ships the whole docs tree, never a partial glob of it", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { readonly files: ReadonlyArray<string> }

    // `docs/*.md` shipped the four top-level pages and none of the `guides/`
    // and `concepts/` pages they link to, so the tarball carried a docs tree
    // whose own links were broken. Every public package now ships its whole
    // `docs/` tree (`.smithers/flows/docs-sync/package-docs.test.mjs`), so those links resolve.
    expect(manifest.files.filter((pattern) => pattern.startsWith("docs"))).toEqual(["docs/"])
    expect(manifest.files).toContain("README.md")
  })
})
