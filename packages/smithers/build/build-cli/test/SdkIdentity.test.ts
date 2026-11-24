import { execFileSync } from "node:child_process"
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
  it("is its content, its manifests and its path", async () => {
    const root = await temporary()
    const workspace = await temporary()
    await write(root, "sdk/SDKSettings.json", "{\"Version\":\"26.0\"}")
    await write(root, "sdk/usr/include/fixture.h", "one")
    const sdk = Path.join(root, "sdk")
    const first = SdkIdentity.identify(sdk, workspace)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(SdkIdentity.identify(sdk, workspace)).toBe(first)
    // A header changed in place under an unchanged manifest is another SDK.
    await write(root, "sdk/usr/include/fixture.h", "two")
    const changed = SdkIdentity.identify(sdk, workspace)
    expect(changed).toMatch(/^[0-9a-f]{64}$/)
    expect(changed).not.toBe(first)
    // A manifest never stands in for a tree past the limits.
    expect(SdkIdentity.identify(sdk, workspace, { entries: 0, bytes: 0 })).toBeNull()
    await write(root, "sdk/SDKSettings.json", "{\"Version\":\"26.1\"}")
    const second = SdkIdentity.identify(sdk, workspace)
    expect(second).not.toBe(changed)
    // Each manifest counts, and the same content at another path is another SDK.
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
    const first = SdkIdentity.identify(developer, workspace)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    await write(root, "Xcode.app/Contents/version.plist", "<plist>17A2</plist>")
    const second = SdkIdentity.identify(developer, workspace)
    expect(second).not.toBe(first)
    // The version beside it does not excuse a tool changed in place.
    await write(root, "Xcode.app/Contents/Developer/usr/bin/tool", "other")
    expect(SdkIdentity.identify(developer, workspace)).not.toBe(second)
    expect(SdkIdentity.identify(developer, workspace, { entries: 0, bytes: 0 })).toBeNull()
    // A directory of another name does not take its parent's file for a manifest.
    await write(root, "Other/version.plist", "<plist>1</plist>")
    await write(root, "Other/Developer/tool", "tool")
    const other = SdkIdentity.identify(Path.join(root, "Other/Developer"), workspace)
    await write(root, "Other/version.plist", "<plist>2</plist>")
    expect(SdkIdentity.identify(Path.join(root, "Other/Developer"), workspace)).toBe(other)
    // A directory named like a manifest is read as a directory.
    await write(root, "Odd/SDKSettings.json/inner", "x")
    const odd = SdkIdentity.identify(Path.join(root, "Odd"), workspace)
    expect(odd).toMatch(/^[0-9a-f]{64}$/)
    await write(root, "Odd/SDKSettings.json/inner", "y")
    expect(SdkIdentity.identify(Path.join(root, "Odd"), workspace)).not.toBe(odd)
  })

  it("is the whole of a directory that has no manifest", async () => {
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

  it.skipIf(!posix)("follows a link out of the root to a file's bytes and a directory's contents", async () => {
    const root = await temporary()
    const outside = await temporary()
    const workspace = await temporary()
    await write(outside, "lib.tbd", "one")
    await write(outside, "headers/nested/inner.h", "inner")
    await write(root, "sdk/SDKSettings.json", "{\"Version\":\"26.0\"}")
    await write(root, "sdk/header.h", "h")
    const sdk = Path.join(root, "sdk")
    await Fs.symlink(Path.join(outside, "lib.tbd"), Path.join(sdk, "lib.tbd"))
    await Fs.symlink(Path.join(outside, "headers"), Path.join(sdk, "include"))
    const first = SdkIdentity.identify(sdk, workspace)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    await write(outside, "lib.tbd", "two")
    const second = SdkIdentity.identify(sdk, workspace)
    expect(second).not.toBe(first)
    // A header behind a linked directory changes in place: the manifest and
    // the link's text are what they were, and the identity is not.
    await write(outside, "headers/nested/inner.h", "changed")
    expect(await Fs.readlink(Path.join(sdk, "include"))).toBe(Path.join(outside, "headers"))
    const third = SdkIdentity.identify(sdk, workspace)
    expect(third).toMatch(/^[0-9a-f]{64}$/)
    expect(third).not.toBe(second)
    // The same contents behind another link text are another identity.
    await Fs.symlink("headers", Path.join(outside, "alias"))
    await Fs.rm(Path.join(sdk, "include"))
    await Fs.symlink(Path.join(outside, "alias"), Path.join(sdk, "include"))
    expect(SdkIdentity.identify(sdk, workspace)).not.toBe(third)
  })

  it.skipIf(!posix)("counts a linked directory's entries and bytes against the limits", async () => {
    const root = await temporary()
    const outside = await temporary()
    const workspace = await temporary()
    await write(outside, "headers/a.h", "1234")
    await write(outside, "headers/b.h", "5678")
    await Fs.mkdir(Path.join(root, "sdk"))
    const sdk = Path.join(root, "sdk")
    await Fs.symlink(Path.join(outside, "headers"), Path.join(sdk, "include"))
    // The link and the two files behind it are three entries and eight bytes.
    expect(SdkIdentity.identify(sdk, workspace, { entries: 3, bytes: 8 })).toMatch(/^[0-9a-f]{64}$/)
    expect(SdkIdentity.identify(sdk, workspace, { entries: 2, bytes: 8 })).toBeNull()
    expect(SdkIdentity.identify(sdk, workspace, { entries: 3, bytes: 7 })).toBeNull()
  })

  it.skipIf(!posix)("reads a linked cycle once", async () => {
    const root = await temporary()
    const workspace = await temporary()
    await write(root, "sdk/usr/include/a.h", "a")
    const sdk = Path.join(root, "sdk")
    await Fs.symlink("..", Path.join(sdk, "usr/up"))
    await Fs.symlink(sdk, Path.join(sdk, "usr/include/top"))
    await Fs.symlink(".", Path.join(sdk, "self"))
    const first = SdkIdentity.identify(sdk, workspace, { entries: 16, bytes: 16 })
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(SdkIdentity.identify(sdk, workspace, { entries: 16, bytes: 16 })).toBe(first)
    await write(root, "sdk/usr/include/a.h", "b")
    expect(SdkIdentity.identify(sdk, workspace, { entries: 16, bytes: 16 })).not.toBe(first)
  })

  it.skipIf(!posix)("has none when a link leads nowhere, under a manifest or not", async () => {
    const root = await temporary()
    const workspace = await temporary()
    await write(root, "sdk/header.h", "h")
    const sdk = Path.join(root, "sdk")
    const whole = SdkIdentity.identify(sdk, workspace)
    expect(whole).toMatch(/^[0-9a-f]{64}$/)
    await Fs.symlink(Path.join(root, "absent"), Path.join(sdk, "dangling"))
    expect(SdkIdentity.identify(sdk, workspace)).toBeNull()
    await write(root, "sdk/SDKSettings.json", "{}")
    expect(SdkIdentity.identify(sdk, workspace)).toBeNull()
    // The target arrives, and the SDK has an identity again.
    await write(root, "absent", "now here")
    expect(SdkIdentity.identify(sdk, workspace)).toMatch(/^[0-9a-f]{64}$/)
  })

  it.skipIf(!posix)("has none when it holds something that is not a file, a directory or a link to one", async () => {
    const root = await temporary()
    const workspace = await temporary()
    await write(root, "sdk/SDKSettings.json", "{}")
    await write(root, "sdk/header.h", "h")
    const sdk = Path.join(root, "sdk")
    expect(SdkIdentity.identify(sdk, workspace)).toMatch(/^[0-9a-f]{64}$/)
    execFileSync("mkfifo", [Path.join(sdk, "pipe")])
    expect(SdkIdentity.identify(sdk, workspace)).toBeNull()
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

  it.skipIf(!posix || process.getuid?.() === 0)("has none when a file below it cannot be read", async () => {
    const root = await temporary()
    const workspace = await temporary()
    await write(root, "sdk/SDKSettings.json", "{}")
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
