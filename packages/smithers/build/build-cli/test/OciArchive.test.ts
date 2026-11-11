import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { expect, it } from "vitest"
import { imageArchive } from "./helpers/OciArchive.ts"

it("stores unpackable filesystem layers with matching OCI digests", async () => {
  const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-oci-layer-"))
  try {
    const archive = imageArchive({ platforms: ["linux/amd64", "linux/arm64"], seed: "content" })
    const path = Path.join(directory, "image.tar")
    await Fs.writeFile(path, archive.bytes)
    for (const image of archive.images) {
      const config = spawnSync("tar", ["-xOf", path, `blobs/sha256/${image.config.slice(7)}`])
      expect(config.status, config.stderr.toString()).toBe(0)
      const decoded = JSON.parse(config.stdout.toString())
      for (const layer of image.layers) {
        const extracted = spawnSync("tar", ["-xOf", path, `blobs/sha256/${layer.slice(7)}`])
        expect(extracted.status, extracted.stderr.toString()).toBe(0)
        expect(`sha256:${createHash("sha256").update(extracted.stdout).digest("hex")}`).toBe(layer)
        expect(decoded.rootfs.diff_ids).toContain(layer)
        const content = spawnSync("tar", ["-xOf", "-", "hello.txt"], { input: extracted.stdout })
        expect(content.status, content.stderr.toString()).toBe(0)
        expect(content.stdout.toString()).toBe(`layer ${decoded.os}/${decoded.architecture} content`)
      }
    }
  } finally {
    await Fs.rm(directory, { recursive: true, force: true })
  }
})
