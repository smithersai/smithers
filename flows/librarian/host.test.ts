import assert from "node:assert/strict"
import { test } from "node:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Option } from "effect"
import { catalog } from "./host.ts"
import { buildProductHost } from "./build.mjs"

const exec = promisify(execFile)
test("catalog keeps write-once artifact identity and honest configured model metadata", async t => {
  const root = await mkdtemp(join(tmpdir(), "librarian-identity-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = { root, repo: "test/repo", gatewayId: "test", credential: "test", artifactDigest: "a".repeat(64), model: "openai:test", persistWiki: async () => {} }
  const first = await catalog(options), again = await catalog(options)
  for (const [index, entry] of first.entries()) {
    assert.deepEqual(entry.descriptor, again[index]!.descriptor)
    assert.equal(Option.getOrThrow(entry.descriptor.model), "openai:test")
    assert.equal(await readFile(entry.descriptor.path, "utf8"), JSON.stringify({ artifact: options.artifactDigest, flow: entry.descriptor.name }))
  }
  const path = first[0]!.descriptor.path
  await chmod(path, 0o644)
  await writeFile(path, "tampered")
  await assert.rejects(catalog(options), /identity was modified/)
})

test("built artifact regenerates its sidecar and refuses off-loopback transcript startup", { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "librarian-artifact-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifact = join(root, "smithers.mjs")
  const digest = await buildProductHost(artifact)
  assert.equal(digest, createHash("sha256").update(await readFile(artifact)).digest("hex"))
  assert.equal(await readFile(`${artifact}.sha256`, "utf8"), `${digest}  smithers.mjs\n`)
  for (const record of ["0", "1"]) {
    await assert.rejects(exec(process.execPath, [artifact, "serve", "--root", resolve(root)], { timeout: 30_000,
      env: { PATH: process.env.PATH, SMITHERS_LIBRARIAN_TRANSCRIPTS: root, SMITHERS_PRODUCT_API_URL: "https://example.com", SMITHERS_LIBRARIAN_RECORD: record }
    }), error => /loopback SMITHERS_PRODUCT_API_URL/.test(String((error as { stderr: string }).stderr)))
  }
})
