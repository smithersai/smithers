import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as SafeFs from "../src/SafeFs.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "input-directory-memo-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("indexed input directory resolution", () => {
  it("records absent parents and paths through ordinary files as absent inputs", async () => {
    await Fs.writeFile(Path.join(root, "regular"), "content")
    const digests = SafeFs.makeDigestIndex()
    expect(await Input.digestFiles(root, ["missing/a", "regular/a"], { digests })).toEqual([
      { path: "missing/a", digest: undefined },
      { path: "regular/a", digest: undefined }
    ])
  })

  it("propagates and forgets a failed canonical directory lookup so the next attempt can recover", async () => {
    const directory = Path.join(root, "src")
    await Fs.mkdir(directory)
    await Fs.writeFile(Path.join(directory, "a"), "content")
    const denied = Object.assign(new Error("directory canonicalization denied"), { code: "EACCES" })
    let failures = 0
    const io: SafeFs.Io = {
      ...SafeFs.defaultIo,
      realpath: async (path) => {
        if (path === directory && failures++ === 0) throw denied
        return SafeFs.defaultIo.realpath(path)
      }
    }
    const digests = SafeFs.makeDigestIndex()
    await expect(Input.digestFiles(root, ["src/a"], { io, digests })).rejects.toBe(denied)
    expect(await Input.digestFiles(root, ["src/a"], { io, digests })).toEqual([
      { path: "src/a", digest: createHash("sha256").update("content").digest("hex") }
    ])
    expect(failures).toBe(2)
  })

  it("rechecks confinement when an indexed input's parent is a link outside the root", async () => {
    const outside = await Fs.mkdtemp(Path.join(Os.tmpdir(), "input-outside-memo-"))
    try {
      await Fs.writeFile(Path.join(outside, "private"), "private-content")
      await Fs.symlink(outside, Path.join(root, "linked"))
      await expect(Input.digestFiles(root, ["linked/private"], { digests: SafeFs.makeDigestIndex() }))
        .rejects.toThrow("outside the workspace")
    } finally {
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })
})

it.each(["/", "!/"])(
  "rejects a workspace pattern that becomes empty after slash normalization: %s",
  async (pattern) => {
    await Fs.writeFile(Path.join(root, "pnpm-workspace.yaml"), `packages: [${JSON.stringify(pattern)}]\n`)
    await expect(Input.expandPnpmWorkspace(root, "", Input.pnpmWorkspace("//pnpm-workspace.yaml")))
      .rejects.toThrow(`contains an empty ${pattern.startsWith("!") ? "exclusion" : "inclusion"}`)
  }
)

describe("shared glob directory boundaries", () => {
  it("returns no matches when the requested shared directory is absent", async () => {
    expect(await Input.expandGlob(root, "", "missing/**/*.ts", { walks: Input.makeWalkCache() })).toEqual([])
  })

  it("treats an empty ignore file as no ignore rules", async () => {
    await Fs.writeFile(Path.join(root, ".gitignore"), "")
    await Fs.writeFile(Path.join(root, "a.ts"), "content")
    expect(await Input.expandGlob(root, "", "*.ts", { walks: Input.makeWalkCache() })).toEqual(["a.ts"])
  })

  it("enters an explicitly selected repository subtree while excluding its state files", async () => {
    await Fs.mkdir(Path.join(root, "vendor/repo/src"), { recursive: true })
    await Fs.mkdir(Path.join(root, "vendor/repo/.flows/nested"), { recursive: true })
    await Fs.writeFile(Path.join(root, "vendor/repo/src/a.ts"), "content")
    await Fs.writeFile(Path.join(root, "vendor/repo/.flows/nested/private.ts"), "state")
    const options = { repositoryBoundaries: ["vendor/repo"] }
    expect(await Input.expandGlob(root, "", "vendor/repo/src/**/*.ts", options))
      .toEqual(["vendor/repo/src/a.ts"])
    expect(await Input.expandGlob(root, "", "vendor/repo/.flows/nested/**/*.ts", options)).toEqual([])
  })
})
