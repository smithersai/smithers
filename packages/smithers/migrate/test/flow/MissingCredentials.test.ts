import { describe, expect, it } from "@effect/vitest"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Command from "@smthrs/migrate/flow/Command"
import * as Report from "@smthrs/migrate/Report"
import * as Effect from "effect/Effect"
import { copyFixture } from "../fixtures/helpers.ts"

describe("missing migration credentials", () => {
  it.effect("reports the refusal and zero attempted repair rounds", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const report = yield* Command.runNode({ root, mode: "apply", allowNoVcs: true }, {
        environment: {},
        evaluator: ScriptedJudge.layer
      })
      expect(report.exitCode).toBe(1)
      const text = Report.toMarkdown(report)
      expect(report.followUps.map((entry) => entry.text).join("\n")).toContain("ANTHROPIC_API_KEY")
      expect(text).not.toContain("failed verification")
      expect(report.followUps.some((entry) => entry.text.includes("failed in the migration agent"))).toBe(true)
      expect(report.units.filter((unit) => unit.status === "failed").every((unit) => unit.repairRounds === 0)).toBe(
        true
      )
    }))
})
