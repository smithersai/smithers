import { describe, expect, it } from "vitest"
import { readJustfile } from "../../src/inventory/Justfile.ts"
import { readMakefile } from "../../src/inventory/Makefile.ts"
import { isPlainCommand } from "../../src/inventory/Values.ts"

describe("isPlainCommand", () => {
  it("accepts a program with plain words", () => {
    expect(isPlainCommand("zig build test -Doptimize=ReleaseSafe")).toBe(true)
  })

  it("refuses a shell builtin, a leading dash and shell syntax", () => {
    expect(isPlainCommand("echo hi")).toBe(false)
    expect(isPlainCommand("cd sub")).toBe(false)
    expect(isPlainCommand("-version")).toBe(false)
    expect(isPlainCommand("make a; echo done")).toBe(false)
    expect(isPlainCommand("cat $FILE")).toBe(false)
  })

  it("decides the same for a Justfile line and a Makefile line", () => {
    const justfile = (line: string) => readJustfile("Justfile", `ci:\n  ${line}\n`).jobs[0]?.steps[0]?.command
    const makefile = (line: string) => readMakefile("Makefile", `ci:\n\t${line}\n`, []).jobs[0]?.steps[0]?.command
    expect([justfile("zig build"), makefile("zig build")]).toEqual(["zig build", "zig build"])
    expect([justfile("echo hi"), makefile("echo hi")]).toEqual(["sh -cu 'echo hi'", "sh -c 'echo hi'"])
  })
})
