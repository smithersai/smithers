import { createHash } from "node:crypto"
import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Executable from "../src/internal/ReviewExecutable.ts"

const capabilities = { paths: Path, nativeStat: Fs.statSync, createHash }
const moduleOptions = (platform: NodeJS.Platform) => ({ platform, stat: Fs.statSync, isAbsolute: Path.isAbsolute })

let root: string
let script: string
let interpreter: string
beforeEach(() => {
  root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "review-executable-"))
  script = Path.join(root, "review.mjs")
  interpreter = Path.join(root, "node")
  Fs.writeFileSync(script, "source-v1")
  Fs.writeFileSync(interpreter, "interpreter-v1")
})
afterEach(() => {
  Fs.rmSync(root, { recursive: true, force: true })
})

describe("review executable identity", () => {
  it("binds both source and interpreter bytes for Windows scripts", async () => {
    const host = { ...capabilities, path: root, platform: "win32" as const, execPath: interpreter }
    const original = await Executable.identity(script, Fs, host)
    expect(original.executable).toMatchObject({
      path: Fs.realpathSync(script),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    Fs.writeFileSync(interpreter, "interpreter-v2")
    const changedInterpreter = await Executable.identity(script, Fs, host)
    expect(changedInterpreter).not.toEqual(original)
    Fs.writeFileSync(script, "source-v2")
    expect(await Executable.identity(script, Fs, host)).not.toEqual(changedInterpreter)
  })

  it("binds native executable bytes independently of the interpreter", async () => {
    const host = { ...capabilities, path: root, platform: "linux" as const, execPath: interpreter }
    const original = await Executable.identity("review.mjs", Fs, host)
    expect(await Executable.identity(Path.relative(process.cwd(), script), Fs, host)).toEqual(original)
    Fs.writeFileSync(interpreter, "interpreter-v2")
    expect(await Executable.identity("review.mjs", Fs, host)).toEqual(original)
    Fs.writeFileSync(script, "source-v2")
    expect(await Executable.identity("review.mjs", Fs, host)).not.toEqual(original)
  })

  it("omits absent executables and skips directory candidates in PATH", async () => {
    const host = { ...capabilities, path: undefined, platform: "linux" as const, execPath: interpreter }
    expect(await Executable.identity("missing", Fs, host)).toEqual({})
    expect(await Executable.identity(Path.join(root, "missing"), Fs, host)).toEqual({})
    Fs.mkdirSync(Path.join(root, "directory"))
    expect(await Executable.identity("directory", Fs, { ...host, path: root })).toEqual({})
  })

  it("runs only absolute existing JavaScript files through Node on Windows", () => {
    expect(Executable.nodeModule(script, moduleOptions("win32"))).toBe(true)
    expect(Executable.nodeModule(script, moduleOptions("linux"))).toBe(false)
    expect(Executable.nodeModule("review.mjs", moduleOptions("win32"))).toBe(false)
    expect(Executable.nodeModule(interpreter, moduleOptions("win32"))).toBe(false)
    expect(Executable.nodeModule(Path.join(root, "missing.js"), moduleOptions("win32"))).toBe(false)
  })
})
