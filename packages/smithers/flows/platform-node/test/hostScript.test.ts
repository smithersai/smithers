import { existsSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { describe, expect, it } from "vitest"
import { cleanupHostScripts, hostScript } from "./hostScript.ts"

describe("host script fixtures", () => {
  it("removes every generated server and its directory after use", () => {
    const sources = ["process.exit(0)", "process.stdout.write('ready')"]
    const files = sources.map(hostScript)
    for (const [index, file] of files.entries()) {
      expect(readFileSync(file, "utf8")).toBe(sources[index])
    }
    cleanupHostScripts()
    for (const file of files) {
      expect(existsSync(file)).toBe(false)
      expect(existsSync(dirname(file))).toBe(false)
    }
    expect(() => cleanupHostScripts()).not.toThrow()
  })
})
