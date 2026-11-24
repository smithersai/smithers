import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as SdkIdentity from "../src/internal/SdkIdentity.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const temporary = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-sdk-identity-")))
  roots.push(root)
  return root
}

const posix = process.platform !== "win32"

describe("the identity of an SDK", () => {
  it("is its manifest and its path, whatever else the tree holds", async () => {
    const root = await temporary()
    const workspace = await temporary()
    await write(root, "sdk/SDKSettings.plist", "<plist>26.0</plist>")
    await write(root, "sdk/usr/include/fixture.h", "one")
    const sdk = Path.join(root, "sdk")
    const first = SdkIdentity.identify(sdk, workspace)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    // The tree is not read: a file below a manifest moves nothing, and no limit applies.
    await write(root, "sdk/usr/include/fixture.h", "two")
    expect(SdkIdentity.identify(sdk, workspace, { entries: 0, bytes: 0 })).toBe(first)
    await write(root, "sdk/SDKSettings.plist", "<plist>26.1</plist>")
    const second = SdkIdentity.identify(sdk, workspace)
    expect(second).not.toBe(first)
    // Each manifest counts, and the same manifests at another path are another SDK.
    await write(root, "sdk/version.plist", "<plist>build</plist>")
    const third = SdkIdentity.identify(sdk, workspace)
    expect(third).not.toBe(second)
    await Fs.cp(sdk, Path.join(root, "copy"), { recursive: true })
    expect(SdkIdentity.identify(Path.join(root, "copy"), workspace)).not.toBe(third)
  })

  it("reads Xcode's version beside Contents/Developer, and only there", async () => {
    const root = await temporary()
    const workspace = await temporary()
    await write(root, "Xcode.app/Contents/version.plist", "<plist>17A1</plist>")
    await write(root, "Xcode.app/Contents/Developer/usr/bin/tool", "tool")
    const developer = Path.join(root, "Xcode.app/Contents/Developer")
    const first = SdkIdentity.identify(developer, workspace, { entries: 0, bytes: 0 })
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    await write(root, "Xcode.app/Contents/version.plist", "<plist>17A2</plist>")
    expect(SdkIdentity.identify(developer, workspace, { entries: 0, bytes: 0 })).not.toBe(first)
    // A directory of another name does not take its parent's file for a manifest.
    await write(root, "Other/version.plist", "<plist>1</plist>")
    await write(root, "Other/Developer/tool", "tool")
    const other = SdkIdentity.identify(Path.join(root, "Other/Developer"), workspace)
    await write(root, "Other/version.plist", "<plist>2</plist>")
    expect(SdkIdentity.identify(Path.join(root, "Other/Developer"), workspace)).toBe(other)
    // A directory named like a manifest is not one.
    await write(root, "Odd/SDKSettings.json/inner", "x")
    expect(SdkIdentity.identify(Path.join(root, "Odd"), workspace, { entries: 0, bytes: 0 })).toBeNull()
  })

  it("is the whole of a small directory that has no manifest", async () => {
    const root = await temporary()
    const workspace = await temporary()
    await write(root, "sdk/include/b.h", "b")
    await write(root, "sdk/include/a.h", "a")
    const sdk = Path.join(root, "sdk")
    const first = SdkIdentity.identify(sdk, workspace)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(SdkIdentity.identify(sdk, workspace)).toBe(first)
    await write(root, "sdk/include/a.h", "changed")
    const second = SdkIdentity.identify(sdk, workspace)
    expect(second).not.toBe(first)
    await Fs.chmod(Path.join(sdk, "include/a.h"), 0o755)
    const third = SdkIdentity.identify(sdk, workspace)
    if (posix) expect(third).not.toBe(second)
    await Fs.mkdir(Path.join(sdk, "empty"))
    expect(SdkIdentity.identify(sdk, workspace)).not.toBe(third)
  })

  it.skipIf(!posix)("follows a link out of a small directory to a file, and keeps one that leads nowhere", async () => {
    const root = await temporary()
    const outside = await temporary()
    const workspace = await temporary()
    await write(outside, "lib.tbd", "one")
    await write(outside, "directory/inner", "inner")
    await write(root, "sdk/header.h", "h")
    const sdk = Path.join(root, "sdk")
    await Fs.symlink(Path.join(outside, "lib.tbd"), Path.join(sdk, "lib.tbd"))
    await Fs.symlink(Path.join(outside, "absent"), Path.join(sdk, "dangling"))
    await Fs.symlink(Path.join(outside, "directory"), Path.join(sdk, "directory"))
    const first = SdkIdentity.identify(sdk, workspace)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    await write(outside, "lib.tbd", "two")
    const second = SdkIdentity.identify(sdk, workspace)
    expect(second).not.toBe(first)
    // A linked directory is its target's text, not its contents.
    await write(outside, "directory/inner", "changed")
    expect(SdkIdentity.identify(sdk, workspace)).toBe(second)
    await Fs.rm(Path.join(sdk, "dangling"))
    await Fs.symlink(Path.join(outside, "elsewhere"), Path.join(sdk, "dangling"))
    expect(SdkIdentity.identify(sdk, workspace)).not.toBe(second)
  })

  it("has none when the directory is missing, holds the workspace, or is too large to read", async () => {
    const root = await temporary()
    const workspace = await temporary()
    expect(SdkIdentity.identify(Path.join(root, "absent"), workspace)).toBeNull()
    await write(root, "sdk/nested/one", "1234")
    await write(root, "sdk/nested/two", "5678")
    const sdk = Path.join(root, "sdk")
    expect(SdkIdentity.identify(sdk, Path.join(sdk, "nested"))).toBeNull()
    expect(SdkIdentity.identify(sdk, sdk)).toBeNull()
    // One directory and two files are three entries and eight bytes.
    expect(SdkIdentity.identify(sdk, workspace, { entries: 3, bytes: 8 })).toMatch(/^[0-9a-f]{64}$/)
    expect(SdkIdentity.identify(sdk, workspace, { entries: 2, bytes: 8 })).toBeNull()
    expect(SdkIdentity.identify(sdk, workspace, { entries: 3, bytes: 7 })).toBeNull()
    expect(SdkIdentity.identify(sdk, workspace, { entries: 0, bytes: 8 })).toBeNull()
  })

  it.skipIf(!posix || process.getuid?.() === 0)("has none when a small directory cannot be read", async () => {
    const root = await temporary()
    const workspace = await temporary()
    await write(root, "sdk/sealed", "x")
    const sealed = Path.join(root, "sdk/sealed")
    await Fs.chmod(sealed, 0o000)
    try {
      expect(SdkIdentity.identify(Path.join(root, "sdk"), workspace)).toBeNull()
    } finally {
      await Fs.chmod(sealed, 0o644)
    }
  })
})
