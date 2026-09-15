import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { releaseRegistry } from "./release-registry.mjs"

test("loopback registry serves packed metadata and verified bytes, and nothing else", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-registry-test-"))
  let registry
  try {
    const manifest = { name: "@smthrs/example", version: "1.0.0-rc.0", dependencies: { effect: "4.0.0-rc.115" } }
    await mkdir(join(root, "package"))
    await writeFile(join(root, "package/package.json"), JSON.stringify(manifest))
    execFileSync("tar", ["-czf", join(root, "example.tgz"), "-C", root, "package"])
    registry = await releaseRegistry(root, [{ ...manifest, filename: "example.tgz" }])
    const response = await fetch(`${registry.url}/@smthrs%2fexample`)
    assert.equal(response.status, 200)
    const metadata = await response.json()
    const version = metadata.versions[manifest.version]
    assert.deepEqual(version.dependencies, manifest.dependencies)
    const tarball = await fetch(version.dist.tarball)
    const bytes = Buffer.from(await tarball.arrayBuffer())
    assert.deepEqual(bytes, await readFile(join(root, "example.tgz")))
    assert.equal(version.dist.integrity, `sha512-${createHash("sha512").update(bytes).digest("base64")}`)
    assert.equal((await fetch(`${registry.url}/@smthrs/missing`)).status, 404)
    assert.equal((await fetch(`${registry.url}/package/package.json`)).status, 404)
    assert.equal((await fetch(new URL("/@smthrs%2fexample", registry.url))).status, 404)
    assert.equal((await fetch(`${registry.url}/@smthrs%2fexample`, { method: "POST" })).status, 405)
    await assert.rejects(releaseRegistry(root, [{ name: "wrong", version: manifest.version, filename: "example.tgz" }]), /Packed identity/)
  } finally {
    await registry?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("cached registry metadata is isolated by candidate bytes even at the same version", async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-registry-cache-test-"))
  const registries = []
  try {
    const manifest = { name: "@smthrs/example", version: "1.0.0-rc.0" }
    await mkdir(join(root, "package"))
    await writeFile(join(root, "package/package.json"), JSON.stringify(manifest))
    const pack = () => execFileSync("tar", ["-czf", join(root, "example.tgz"), "-C", root, "package"])
    const start = async () => {
      const registry = await releaseRegistry(root, [{ ...manifest, filename: "example.tgz" }])
      registries.push(registry)
      return registry
    }
    pack()
    const first = await start()
    const identical = await start()
    assert.equal(new URL(first.url).pathname, new URL(identical.url).pathname)
    await writeFile(join(root, "package/payload.txt"), "a different candidate at the same version\n")
    pack()
    const changed = await start()
    assert.notEqual(new URL(first.url).pathname, new URL(changed.url).pathname)
    const stalePath = new URL(first.url).pathname + "/@smthrs%2fexample"
    assert.equal((await fetch(new URL(stalePath, changed.url))).status, 404)
    const response = await fetch(`${changed.url}/@smthrs%2fexample`)
    assert.equal(response.status, 200)
    const metadata = await response.json()
    assert.ok(metadata.versions[manifest.version].dist.tarball.startsWith(changed.url + "/"))
  } finally {
    for (const registry of registries) await registry.close()
    await rm(root, { recursive: true, force: true })
  }
})
