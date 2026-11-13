import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import * as Vm from "node:vm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Compose from "../src/Compose.ts"
import * as Filegroup from "../src/Filegroup.ts"
import * as Input from "../src/Input.ts"
import { PublicationFileSystem } from "../src/internal/PublicationFileSystem.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "generator-root-output-")))
  await Fs.mkdir(Path.join(root, "nested"))
  await Fs.writeFile(Path.join(root, "nested/original"), "original")
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("workspace root generator outputs", () => {
  it("checks and restores descendants when the declared output is the workspace root", async () => {
    const error = await Effect.runPromise(Effect.flip(Compose.checkGenerator({ workspaceRoot: root }, {
      changes: ["."],
      run: {
        cwd: ".",
        argv: [process.execPath, "-e", "require('node:fs').writeFileSync('nested/original','changed')"],
        env: {},
        secrets: [],
        expectedExitCodes: [0],
        timeoutMs: 5000
      }
    })))
    expect(error._tag).toBe("smithers-build/DriftError")
    expect(await Fs.readFile(Path.join(root, "nested/original"), "utf8")).toBe("original")
    expect((await Fs.stat(root)).isDirectory()).toBe(true)
  })

  it("anchors a filegroup operand to its actual declaration directory", () => {
    const declaration = Path.join(root, "nested/PACKAGE.ts")
    const make = Vm.compileFunction("return Filegroup({srcs:[Input.file('original')]})", ["Filegroup", "Input"], {
      filename: declaration
    })
    const group = make(Filegroup.Filegroup, Input) as ReturnType<typeof Filegroup.Filegroup>
    expect(Compose.checkOperand(group)).toEqual({
      _tag: "SourceSet",
      sources: [{ base: Path.dirname(declaration), source: Input.file("original") }]
    })
  })
})

it("refuses root replacement after a real directory-to-file race between metadata reads", async () => {
  const parked = root + "-parked"
  let observations = 0
  let raced = false
  const io = {
    ...Fs,
    lstat: async (...args: Parameters<typeof Fs.lstat>) => {
      if (args[0] === root && !raced && await Fs.access(Path.join(root, "ran")).then(() => true, () => false)) {
        observations++
        if (observations === 2) {
          raced = true
          await Fs.rename(root, parked)
          try {
            await Fs.writeFile(root, "raced file")
            return await Fs.lstat(...args)
          } finally {
            await Fs.rm(root, { force: true })
            await Fs.rename(parked, root)
          }
        }
      }
      return Fs.lstat(...args)
    }
  } as typeof Fs
  const error = await Effect.runPromise(Effect.flip(
    Compose.checkGenerator({ workspaceRoot: root }, {
      changes: ["."],
      run: {
        cwd: ".",
        argv: [process.execPath, "-e", "require('node:fs').writeFileSync('ran','ran')"],
        env: {},
        secrets: [],
        expectedExitCodes: [0],
        timeoutMs: 5000
      }
    }).pipe(Effect.provideService(PublicationFileSystem, io))
  ))
  expect(raced).toBe(true)
  expect(error._tag).toBe("smithers-build/DriftError")
  if (error._tag !== "smithers-build/DriftError") throw new Error("expected restoration refusal")
  expect(error.message).toContain("the workspace root cannot be replaced as a declared output")
  expect(await Fs.readFile(Path.join(root, "nested/original"), "utf8")).toBe("original")
})
