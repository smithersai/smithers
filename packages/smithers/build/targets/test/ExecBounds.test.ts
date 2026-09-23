import { describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import { ToolRun } from "../src/ToolRun.ts"
import { Vitest } from "../src/Vitest.ts"
import { VitestCoverage } from "../src/VitestCoverage.ts"
import { VitestWatch } from "../src/VitestWatch.ts"
import { packageManager } from "./toolchain.ts"

const toolRun = (extra: Record<string, unknown>) =>
  ToolRun({ command: "firectl", args: [], inputs: [], deps: [], ...extra } as never)

describe("declarations reject exec payloads the shared runner would refuse", () => {
  it("bounds Shell durations to the shared exec range", () => {
    expect(Target.isTarget(Shell.Test({ shell: "true", timeout: "1ms" }))).toBe(true)
    expect(Target.isTarget(Shell.Test({ shell: "true", timeout: "24h" }))).toBe(true)
    expect(Target.isTarget(Shell.Test({ shell: "true", timeout: `${Exec.maximumTimeoutMs}ms` }))).toBe(true)
    expect(() => Shell.Test({ shell: "true", timeout: "0ms" })).toThrow(/timeout/)
    expect(() => Shell.Test({ shell: "true", timeout: "0h" })).toThrow(/timeout/)
    expect(() => Shell.Test({ shell: "true", timeout: "25h" })).toThrow(/timeout/)
    expect(() => Shell.Test({ shell: "true", timeout: `${Exec.maximumTimeoutMs + 1}ms` })).toThrow(/timeout/)
    expect(() => Shell.Test({ shell: "true", timeout: `${"9".repeat(400)}s` })).toThrow(/timeout/)
  })

  it("bounds ToolRun expected exit codes and timeouts", () => {
    expect(Target.isTarget(toolRun({ expectedExitCodes: [0, 1], timeoutMs: Exec.maximumTimeoutMs }))).toBe(true)
    expect(() => toolRun({ expectedExitCodes: [-1] })).toThrow()
    expect(() => toolRun({ expectedExitCodes: [1, 1] })).toThrow(/duplicate/)
    expect(() => toolRun({ expectedExitCodes: [0x1_0000_0000] })).toThrow()
    expect(() => toolRun({ expectedExitCodes: Array.from({ length: 257 }, (_, i) => i) })).toThrow()
    expect(() => toolRun({ timeoutMs: 0 })).toThrow()
    expect(() => toolRun({ timeoutMs: Exec.maximumTimeoutMs + 1 })).toThrow()
  })

  const vitestFamily = {
    Vitest: (timeoutMs: number) =>
      Vitest(
        {
          packageManager,
          tests: [],
          sources: [],
          deps: [],
          config: null,
          environment: "node",
          passWithNoTests: false,
          cwd: ".",
          timeoutMs
        } as never
      ),
    VitestCoverage: (timeoutMs: number) =>
      VitestCoverage({
        packageManager,
        tests: [],
        sources: [],
        deps: [],
        config: null,
        provider: "v8",
        reportsDirectory: "coverage",
        thresholds: { branches: 0, functions: 0, lines: 0, statements: 0 },
        cwd: ".",
        timeoutMs
      } as never),
    VitestWatch: (timeoutMs: number) =>
      VitestWatch(
        {
          packageManager,
          tests: [],
          sources: [],
          deps: [],
          config: null,
          environment: "node",
          cwd: ".",
          timeoutMs
        } as never
      )
  }

  for (const [name, make] of Object.entries(vitestFamily)) {
    it(`bounds ${name} timeoutMs at construction`, () => {
      expect(Target.isTarget(make(1))).toBe(true)
      expect(Target.isTarget(make(Exec.maximumTimeoutMs))).toBe(true)
      expect(() => make(0)).toThrow()
      expect(() => make(-1)).toThrow()
      expect(() => make(Exec.maximumTimeoutMs + 1)).toThrow()
    })
  }
})
