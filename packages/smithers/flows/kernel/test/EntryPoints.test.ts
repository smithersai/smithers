import { readdir, readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import manifest from "../package.json" with { type: "json" }

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), "utf8")

describe("documented entry points", () => {
  it.each(["exports", "publishConfig.exports"])("exports every API table entry in %s", async (map) => {
    const api = await read("docs/api.md")
    const table = api.split("## Entry points\n")[1]?.split("\n## ")[0] ?? ""
    const imports = [...table.matchAll(/^\| `(@smthrs\/kernel[^`]*)`/gm)].map((match) => match[1]!)
    expect(imports.length).toBeGreaterThan(0)
    const exports = map === "exports" ? manifest.exports : manifest.publishConfig.exports
    for (const entry of imports) {
      const subpath = entry.replace("@smthrs/kernel", ".")
      expect(Object.hasOwn(exports, subpath), entry).toBe(true)
      expect(exports[subpath as keyof typeof exports], entry).not.toBeNull()
    }
  })

  it.each(["README.md", "docs/api.md", "docs/testing.md"])(
    "removes obsolete helper and peer guidance from %s",
    async (path) => {
      const doc = await read(path)
      expect(doc).not.toContain("@smthrs/kernel/test/TestHost")
      expect(doc).not.toContain("@smthrs/platform-browser@")
      expect(doc).toContain("@smthrs/testing/TestHost")
    }
  )

  it("declares the overview example's separate testing package requirement", async () => {
    const overview = await read("docs/README.md")
    expect(overview).not.toContain("nothing else installed")
    expect(overview).toContain("\"@smthrs/testing\": \"workspace:*\"")
  })

  it("does not require the unused browser platform", () => {
    for (const dependencies of [manifest.peerDependencies, manifest.peerDependenciesMeta, manifest.devDependencies]) {
      expect(dependencies).not.toHaveProperty("@smthrs/platform-browser")
    }
  })

  it.each([
    ["@effect/platform-node", "4.0.0-rc.115"],
    ["@smthrs/database", manifest.version]
  ])("declares integration-only %s as a development dependency", async (dependency, version) => {
    const files = await readdir(new URL("../test/", import.meta.url))
    const sources = await Promise.all(
      files.filter((file) => file.endsWith(".integration.test.ts")).map((file) => read(`test/${file}`))
    )
    expect(sources.some((source) => source.includes(`from "${dependency}/`))).toBe(true)
    expect(manifest.devDependencies).toHaveProperty(dependency, version)
    expect(manifest.dependencies).not.toHaveProperty(dependency)
    expect(manifest.peerDependencies).not.toHaveProperty(dependency)
  })
})
