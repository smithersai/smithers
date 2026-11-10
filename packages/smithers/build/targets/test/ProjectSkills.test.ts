import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
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

describe("the installation payload (VIP-44)", () => {
  const library = Skills.Library({ root: "Org/Skills" })
  const dependency = Skills.Install({ library, agents: ["claude"] })

  it("leaves target references out of the durable payload", () => {
    const target = Skills.Install({ library, agents: ["codex"], select: ["audit"], deps: [dependency] })
    expect((Target.metadata(target).attrs as Skills.Attrs).deps).toEqual([dependency])
    expect(Target.plan(target)).toMatchObject({
      ast: {
        _tag: "ActionCall",
        payload: { library: { _tag: "Skills.Library", root: "Org/Skills" }, agents: ["codex"], select: ["audit"] }
      }
    })
    expect(JSON.stringify(Target.plan(target).ast)).not.toContain("deps")
    const everySkill = Skills.Install({ library, agents: ["claude"] })
    expect(Target.plan(everySkill)).toMatchObject({ ast: { payload: { agents: ["claude"] } } })
    expect(JSON.stringify(Target.plan(everySkill).ast)).not.toContain("select")
  })

  it("has a JSON codec for every payload, which the target attributes never had", () => {
    const codec = Schema.toCodecJson(Skills.InstallPayload)
    const payload = { library, agents: ["codex", "claude"] as const, select: ["audit"] }
    const encoded = Effect.runSync(Schema.encodeEffect(codec)(payload))
    expect(encoded).toEqual({
      library: { _tag: "Skills.Library", root: "Org/Skills" },
      agents: ["codex", "claude"],
      select: ["audit"]
    })
    expect(Effect.runSync(Schema.decodeUnknownEffect(codec)(encoded))).toEqual(payload)
    // A target reference passes through the JSON codec as the live object; once it is
    // bytes it is a bare `_tag`, and that never decodes back to a target.
    const attrs = Schema.toCodecJson(Skills.Attrs)
    const lossy = Effect.runSync(Schema.encodeEffect(attrs)({ library, agents: ["codex"], deps: [dependency] }))
    const stored = JSON.parse(JSON.stringify(lossy))
    expect(stored.deps).toEqual([{ _tag: "Skills.Install" }])
    expect(Effect.runSync(Effect.exit(Schema.decodeUnknownEffect(attrs)(stored)))._tag).toBe("Failure")
    const fromBytes = JSON.parse(JSON.stringify(encoded))
    expect(Effect.runSync(Schema.decodeUnknownEffect(codec)(fromBytes))).toEqual({
      library,
      agents: ["codex", "claude"],
      select: ["audit"]
    })
  })
})
