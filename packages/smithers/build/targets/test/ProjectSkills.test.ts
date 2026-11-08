import { describe, expect, it } from "vitest"
import * as Skills from "../src/Skills.ts"
import * as Target from "../src/Target.ts"

it("declares an inert skill library and a durable run-only installation", () => {
  const library = Skills.Library({ root: "./Org//Skills/" })
  expect(library.root).toBe("Org/Skills")
  expect(Object.isFrozen(library)).toBe(true)
  const target = Skills.Install({ library, agents: ["codex"], select: ["release"] })
  const metadata = Target.metadata(target)
  expect(metadata.kinds).toEqual(["run"])
  expect(metadata.verbGate).toEqual(["run"])
  const run = metadata.forKind("run")
  expect(run.cacheable).toBe(false)
  expect(run.inputs).toMatchObject([{ pattern: "//Org/Skills/**/*" }])
  expect(Target.plan(target)).toMatchObject({ ast: { _tag: "ActionCall", action: "smithers-build/skills-install" } })
})

describe("skill library roots", () => {
  it.each(["", ".", "../Skills", "/tmp/skills", "C:\\skills", "Skills\u0000", "x".repeat(4097), 42])(
    "refuses unsafe root %j",
    (root) => {
      expect(() => Skills.Library({ root: root as string })).toThrow(/Skills library root/)
    }
  )
})
