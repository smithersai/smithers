import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = (path: string) => new URL(`../src/${path}`, import.meta.url)

describe("module names", () => {
  it("gives unrelated modules distinct names", () => {
    for (const reused of ["history/Legacy.ts", "internal/History.ts", "evaluation/Cli.ts"]) {
      expect(existsSync(source(reused)), reused).toBe(false)
    }
    for (const renamed of ["history/ExecutionTarget.ts", "internal/BoundedEvents.ts", "evaluation/EvalCli.ts"]) {
      expect(existsSync(source(renamed)), renamed).toBe(true)
    }
  })

  it("names the suggest checklist entry apart from the doctor check", () => {
    const checklist = readFileSync(source("suggest/Checklist.ts"), "utf8")
    expect(checklist).not.toMatch(/export interface Check\b/)
    expect(checklist).toMatch(/export interface Rule\b/)
  })
})
