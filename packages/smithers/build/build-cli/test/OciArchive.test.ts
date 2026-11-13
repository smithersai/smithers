import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { expect, it } from "vitest"
import { imageArchive, tar } from "./helpers/OciArchive.ts"

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

for (const paxSize of [false, true]) {
  it.each([
    ["one-digit length", "a"],
    ["two-digit length rollover", "aa"],
    ["ASCII", "ascii.txt"],
    ["accented", "café.txt"],
    ["CJK", "値.txt"],
    ["astral", "🚀.txt"],
    ["combining", "cafe\u0301.txt"],
    ["below three-digit length", "é".repeat(43) + ".txt"],
    ["three-digit length rollover", "é".repeat(44) + ".txt"],
    ["below four-digit length", "値".repeat(328) + ".txt"],
    ["four-digit length rollover", "値".repeat(329) + ".txt"]
  ])("extracts %s PAX path with an independent tar reader (paxSize=" + paxSize + ")", (_label, name) => {
    const body = "test café 🚀"
    const archive = tar([
      { name, body, pax: true, paxSize },
      { name: "following.txt", body: "following entry" }
    ])
    // libarchive converts PAX paths through the process locale.
    const env = { ...process.env, LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8" }
    const listed = spawnSync("tar", ["-tf", "-"], { input: archive, env })
    expect(listed.status, listed.stderr.toString()).toBe(0)
    const paths = listed.stdout.toString().trimEnd().split("\n")
    // Readers may normalize Unicode names while decoding PAX paths.
    expect(paths.map((path) => path.normalize("NFC"))).toEqual([name.normalize("NFC"), "following.txt"])
    const extracted = spawnSync("tar", ["-xOf", "-", paths[0]!], { input: archive, env })
    expect(extracted.status, extracted.stderr.toString()).toBe(0)
    expect(extracted.stdout.toString()).toBe(body)
    const following = spawnSync("tar", ["-xOf", "-", "following.txt"], { input: archive, env })
    expect(following.status, following.stderr.toString()).toBe(0)
    expect(following.stdout.toString()).toBe("following entry")
  })
}
