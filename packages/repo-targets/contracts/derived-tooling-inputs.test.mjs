import fc from "fast-check"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import test from "node:test"
import { repoRoot } from "../scripts/workspace-packages.mjs"

const corpus = JSON.parse(readFileSync(new URL("./corpus/smithers-derived-tooling.json", import.meta.url), "utf8"))
const read = (path) => JSON.parse(readFileSync(join(repoRoot, path), "utf8"))
for (const file of corpus.dprintConfigs) {
  test("formatter separates source and derived outputs: " + file, () => {
    const config = read(file)
    for (const pattern of corpus.requiredIgnores) {
      assert.ok(config.excludes?.includes(pattern), file + " lacks " + pattern)
    }
  })
}

const dprint = join(repoRoot, "packages/smithers/flows/platform-node/node_modules/.bin/dprint")
const invoke = (argv) => spawnSync(dprint, argv, { cwd: repoRoot, encoding: "utf8" })
test("derived exclusions preserve authored sources across path and companion names", { timeout: 180_000 }, async () => {
  mkdirSync(join(repoRoot, ".cache"), { recursive: true })
  const root = mkdtempSync(join(repoRoot, ".cache/derived-tooling-"))
  try {
    const config = read(corpus.sampleConfig)
    writeFileSync(join(root, "dprint.json"), JSON.stringify(config))
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("plain", "with space", "café", "nested/leaf"), async (stem) => {
        const source = ["src/" + stem + ".ts", "src/" + stem + ".platform.ts", "src/" + stem + ".vibe"]
        const derived = [
          "src/" + stem + ".d.vibe.ts",
          "src/" + stem + ".d.vibex.ts",
          "src/" + stem + ".vibe.throwing.d.ts",
          "src/" + stem + ".vibex.platform.d.ts",
          ".vibe/declarations/" + stem + ".d.vibe.ts",
          ".vibelang/js/" + stem + ".js"
        ]
        for (const file of [...source, ...derived]) {
          mkdirSync(dirname(join(root, file)), { recursive: true })
          writeFileSync(join(root, file), "export const value=1;" + String.fromCharCode(10))
        }
        const result = invoke([
          "output-file-paths",
          "--config-discovery=ignore-descendants",
          "--no-gitignore",
          "--config",
          join(root, "dprint.json"),
          ...[...source, ...derived].map((file) => join(root, file))
        ])
        assert.equal(result.status, 0, result.stdout + result.stderr)
        const selected = result.stdout.trim().split(String.fromCharCode(10)).filter(Boolean).map((file) =>
          relative(root, file)
        ).sort()
        assert.deepEqual(selected, [...source].sort(), "authored source remains selected while derived outputs do not")
      }),
      { seed: corpus.seed, numRuns: 8, examples: [["with space"], ["café"], ["nested/leaf"]] }
    )
    const authored = join(root, "src/bad-source.ts")
    writeFileSync(authored, "export const value={answer:42};" + String.fromCharCode(10))
    const result = invoke([
      "check",
      "--config-discovery=ignore-descendants",
      "--no-gitignore",
      "--config",
      join(root, "dprint.json"),
      authored
    ])
    assert.equal(result.status, 20, result.stdout + result.stderr)
    assert.match(result.stdout + result.stderr, /bad-source.ts/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
