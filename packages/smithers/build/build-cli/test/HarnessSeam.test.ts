import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The execution suites read a run's output through the injected terminals of
 * helpers/ServeCli.ts. Only Reporter.test.ts may touch the process streams,
 * because it pins the `process.stderr` default itself.
 */
const allowed = new Set(["Reporter.test.ts"])

describe("CLI test harness", () => {
  it("never reassigns process.stdout.write or process.stderr.write outside the Reporter default test", async () => {
    const directory = import.meta.dirname
    const offenders: Array<string> = []
    for (const name of (await Fs.readdir(directory)).sort()) {
      if (!name.endsWith(".ts") || allowed.has(name)) continue
      const text = await Fs.readFile(NodePath.join(directory, name), "utf8")
      if (/process\.std(?:out|err)\.write\s*=[^=]/.test(text)) offenders.push(name)
    }
    expect(offenders).toEqual([])
  })
})
