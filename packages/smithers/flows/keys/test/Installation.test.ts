import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

it.each(["README.md", "docs/installation.md"])("%s names the platform used by its Node example", (path) => {
  const document = readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

  expect(manifest.devDependencies["@effect/platform-node"]).toBeDefined()
  expect(document).toContain("import * as NodeCrypto from \"@effect/platform-node/NodeCrypto\"")
  expect(document).toContain("`@effect/platform-node` provides `NodeCrypto`")
  // The package is on npm under `next`, which carries the 1.0 release candidates.
  expect(document).toContain("npm install @smthrs/keys@next effect")
  expect(document).not.toMatch(/not on npm/i)
})

// Compile the fenced text readers copy, including the testing guide's shared setup.
it.each(["installation", "testing"])("%s TypeScript examples compile with the current Digest API", (page) => {
  const document = readFileSync(new URL(`../docs/${page}.md`, import.meta.url), "utf8")
  const blocks = [...document.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]!)
  expect(blocks.length).toBeGreaterThan(0)
  const sources = page === "testing" ? [blocks.join("\n")] : blocks
  const directory = mkdtempSync(fileURLToPath(new URL("./.docs-", import.meta.url)))
  try {
    for (const [index, source] of sources.entries()) {
      writeFileSync(join(directory, `example-${index}.ts`), source)
    }
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        extends: "../../tsconfig.test.json",
        compilerOptions: { incremental: false },
        include: ["*.ts"]
      })
    )
    const compiler = fileURLToPath(new URL("./bin/vibelang", import.meta.resolve("vibelang/package.json")))
    const result = spawnSync(process.execPath, [compiler, "-p", join(directory, "tsconfig.json"), "--noEmit"], {
      encoding: "utf8"
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
