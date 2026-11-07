/**
 * Proves that local compiler pins can be installed from a repository checkout.
 * @since 0.1.0
 */

import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { repoRoot, workspacePackages } from "../scripts/workspace-packages.mjs"

const assertArchives = (root, members) => {
  const names = new Set(["vibelang", "vibelang-runtime", "vibelang-vite", "vibelang-unplugin"])
  const archives = new Map()
  for (const { manifestPath: file, manifest: pkg } of members) {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (!names.has(name) || typeof spec !== "string" || !spec.startsWith("file:") || !spec.endsWith(".tgz")) continue
        const archive = resolve(dirname(file), spec.slice(5))
        assert.ok(basename(archive).startsWith(name + "-"), relative(root, archive))
        archives.set(archive, basename(archive).slice(name.length + 1))
      }
    }
  }
  for (const [archive, address] of archives) {
    assert.ok(existsSync(archive), relative(root, archive))
    const checksum = /^\d.*-([a-f0-9]{12})\.tgz$/.exec(address)?.[1]
    assert.ok(checksum, relative(root, archive))
    const actual = createHash("sha256").update(readFileSync(archive)).digest("hex")
    assert.equal(actual.slice(0, 12), checksum, relative(root, archive))
  }
}

test("local VibeLang package archives are present and match their content addresses", () => {
  const rootManifest = join(repoRoot, "package.json")
  assertArchives(repoRoot, [
    { manifestPath: rootManifest, manifest: JSON.parse(readFileSync(rootManifest, "utf8")) },
    ...workspacePackages(repoRoot)
  ])
})

test("archive references reject missing and corrupt payloads across dependency fields", () => {
  const fc = createRequire(import.meta.url)("fast-check")
  const root = mkdtempSync(join(tmpdir(), "toolchain-archive-contract-"))
  try {
    fc.assert(fc.property(
      fc.constantFrom("vibelang", "vibelang-runtime", "vibelang-vite", "vibelang-unplugin"),
      fc.constantFrom("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"),
      fc.uint8Array({ minLength: 1, maxLength: 256 }),
      (name, field, bytes) => {
        const payload = Buffer.from(bytes)
        const address = createHash("sha256").update(payload).digest("hex").slice(0, 12)
        const archive = join(root, name + "-0.0.12-" + address + ".tgz")
        const members = [{ manifestPath: join(root, "package.json"), manifest: { [field]: { [name]: "file:./" + basename(archive) } } }]
        writeFileSync(archive, payload)
        assertArchives(root, members)
        const corrupted = Buffer.from(payload)
        corrupted[0] ^= 1
        writeFileSync(archive, corrupted)
        assert.throws(() => assertArchives(root, members), /AssertionError/)
        rmSync(archive)
        assert.throws(() => assertArchives(root, members), /AssertionError/)
      }
    ), { numRuns: 100 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
