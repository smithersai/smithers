import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { compileFunction } from "node:vm"
import { expect, it } from "vitest"
import * as Compose from "../src/Compose.ts"
import * as Filegroup from "../src/Filegroup.ts"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"

it.each(["PACKAGE.ts", "WORKSPACE.ts"])("anchors declarations in a real host-compiled %s call site", async (name) => {
  const root = await Fs.mkdtemp(join(tmpdir(), "honest-source-site-"))
  const path = join(root, name)
  try {
    await Fs.writeFile(path, "return declare()")
    // The host compiles its own routed file, but calls these Vite-loaded helpers.
    // Coverage belongs to their actual transform, not to a native module copy.
    const declare = () => {
      const group = Filegroup.Filegroup({ srcs: [Input.file("entry.ts")], cwd: "." })
      return { group, closure: Compose.ImportClosure({ entries: group }) }
    }
    const call = compileFunction(await Fs.readFile(path, "utf8"), ["declare"], { filename: path })
    const { group, closure } = call(declare)
    expect(Target.metadata(closure).sourceFile).toBe(path)
    expect(Compose.checkOperand(closure)).toEqual({
      _tag: "Closure",
      entries: [
        { base: dirname(path), source: Input.file("entry.ts") }
      ]
    })
    expect(Target.metadata(group).sourceFile).toBe(path)
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})
