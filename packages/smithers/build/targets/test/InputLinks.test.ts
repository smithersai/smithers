/**
 * Symbolic links as declared inputs: a link input is keyed by its own target
 * string, never followed, wherever that string points. Globs list such links only for a declared input expansion,
 * and enter a `node_modules` directory only when a `.gitignore` negation rule
 * says the workspace tracks it.
 */
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as SafeFs from "../src/SafeFs.ts"

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const link = async (target: string, relative: string): Promise<void> => {
  await Fs.mkdir(NodePath.dirname(NodePath.join(root, relative)), { recursive: true })
  await Fs.symlink(target, NodePath.join(root, relative))
}

const identity = (target: string): string => createHash("sha256").update(`symlink\0${target}`).digest("hex")

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-input-links-")))
  await write("consumer/agent/index.js", "agent\n")
  await link("agent", "consumer/alias")
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe.runIf(process.platform !== "win32")("Input links", () => {
  it("constructs a pure Link declaration the guard recognizes", () => {
    expect(Input.link("consumer/alias")).toEqual({ _tag: "Link", path: "consumer/alias" })
    expect(Input.isDeclared(Input.link("consumer/alias"))).toBe(true)
  })

  it("keys a link by its target string and never by what it points at", async () => {
    expect(await Input.digestLink(root, "consumer/alias")).toEqual({
      path: "consumer/alias",
      digest: identity("agent"),
      link: "agent"
    })
    await link("missing", "consumer/dangling")
    expect(await Input.digestLink(root, "consumer/dangling")).toMatchObject({ link: "missing" })
  })

  it("records a missing link, or one below a missing directory, as absent", async () => {
    expect(await Input.digestLink(root, "consumer/gone")).toEqual({ path: "consumer/gone", digest: undefined })
    expect(await Input.digestLink(root, "nowhere/gone")).toEqual({ path: "nowhere/gone", digest: undefined })
    expect(await Input.digestLink(root, "consumer/agent/index.js/below")).toEqual({
      path: "consumer/agent/index.js/below",
      digest: undefined
    })
    await link("x", "top")
    expect(await Input.digestLink(root, "top")).toMatchObject({ link: "x" })
  })

  it.each([
    ["absolute", "/etc/hostname"],
    ["Windows drive", "C:/tools"],
    ["escaping", "../../outside.txt"]
  ])("keys an %s target by its string, as git stores it", async (_, target) => {
    await Fs.rm(NodePath.join(root, "consumer/alias"))
    await link(target, "consumer/alias")
    expect(await Input.digestLink(root, "consumer/alias")).toEqual({
      path: "consumer/alias",
      digest: identity(target),
      link: target
    })
    expect(await Input.digestFiles(root, ["consumer/alias"])).toEqual([
      { path: "consumer/alias", digest: identity(target), link: target }
    ])
  })

  it("refuses a path that is not a link", async () => {
    await expect(Input.digestLink(root, "consumer/agent")).rejects.toBeInstanceOf(Input.LinkRefused)
    await expect(Input.digestLink(root, "consumer/agent")).rejects.toMatchObject({
      path: "consumer/agent",
      reason: "not-a-link",
      message: "declared link input consumer/agent is not a symbolic link"
    })
  })

  it("reads targets through a seam without readlink", async () => {
    const io: SafeFs.Io = { ...SafeFs.defaultIo, readlink: undefined }
    expect(await Input.digestLink(root, "consumer/alias", { io })).toMatchObject({ link: "agent" })
    expect(await Input.expandGlob(root, "", "consumer/*", { io, links: true })).toContain("consumer/alias")
  })

  it("reports a link the seam cannot inspect", async () => {
    const denied = (path: string) =>
      path.endsWith("alias") ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })) : undefined
    const lstat: SafeFs.Io = { ...SafeFs.defaultIo, lstat: (path) => denied(path) ?? SafeFs.defaultIo.lstat(path) }
    await expect(Input.digestLink(root, "consumer/alias", { io: lstat })).rejects.toThrow("denied")
    await expect(Input.digestFiles(root, ["consumer/alias"], { io: lstat })).rejects.toThrow("denied")
    const realpath: SafeFs.Io = {
      ...SafeFs.defaultIo,
      realpath: (path) => denied(path) ?? SafeFs.defaultIo.realpath(path)
    }
    await expect(Input.digestFiles(root, ["consumer/alias"], { io: realpath })).rejects.toThrow("denied")
  })

  it("lists a directory link in a glob only for a declared input expansion", async () => {
    expect(await Input.expandGlob(root, "", "consumer/**")).toEqual(["consumer/agent/index.js"])
    expect(await Input.expandGlob(root, "", "consumer/**", { links: true })).toEqual([
      "consumer/agent/index.js",
      "consumer/alias"
    ])
    await link("/etc/hostname", "consumer/absolute")
    await link("../../outside.txt", "consumer/escaping")
    expect(await Input.expandGlob(root, "", "consumer/**")).toEqual(["consumer/agent/index.js"])
    // A link that points out of the workspace is listed like any other: git tracks it.
    expect(await Input.expandGlob(root, "", "consumer/**", { links: true })).toEqual([
      "consumer/absolute",
      "consumer/agent/index.js",
      "consumer/alias",
      "consumer/escaping"
    ])
    expect(await Input.expandGlob(root, "", "consumer/**/*.js", { links: true })).toEqual(["consumer/agent/index.js"])
  })

  it("digests a link to a workspace file as that file, and every other link as a link", async () => {
    await link("agent/index.js", "consumer/file-link")
    await link("missing", "consumer/dangling")
    await link("loop", "consumer/loop")
    const rows = await Input.digestFiles(root, [
      "consumer/alias",
      "consumer/dangling",
      "consumer/file-link",
      "consumer/loop"
    ])
    expect(rows).toEqual([
      { path: "consumer/alias", digest: identity("agent"), link: "agent" },
      { path: "consumer/dangling", digest: identity("missing"), link: "missing" },
      { path: "consumer/file-link", digest: createHash("sha256").update("agent\n").digest("hex") },
      { path: "consumer/loop", digest: identity("loop"), link: "loop" }
    ])
    expect(await Input.digestFiles(root, ["consumer/absent", "consumer/agent/index.js/below"])).toEqual([
      { path: "consumer/absent", digest: undefined },
      { path: "consumer/agent/index.js/below", digest: undefined }
    ])
  })

  it("enters node_modules only where a .gitignore negation rule un-ignores it", async () => {
    await link("../agent", "consumer/node_modules/agent")
    await write("consumer/node_modules/installed/index.js", "installed\n")
    const expand = (pattern: string) => Input.expandGlob(root, "", pattern, { links: true })
    expect(await expand("consumer/**")).not.toContain("consumer/node_modules/agent")
    expect(await expand("consumer/node_modules/*")).toEqual([])
    await write("consumer/.gitignore", "!node_modules/\nnode_modules/*\n!node_modules/agent\n")
    expect(await expand("consumer/**")).toContain("consumer/node_modules/agent")
    expect(await expand("consumer/**")).not.toContain("consumer/node_modules/installed/index.js")
    expect(await expand("consumer/node_modules/*")).toEqual(["consumer/node_modules/agent"])
  })
})
