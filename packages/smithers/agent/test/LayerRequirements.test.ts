import type * as Evaluator from "@smthrs/model/Evaluator"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Stream from "effect/Stream"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentAction from "../src/AgentAction.ts"
import * as Budget from "../src/Budget.ts"
import * as QuotaPolicy from "../src/QuotaPolicy.ts"

type Requirements<Self> = Self extends Layer.Layer<infer _Success, infer _Error, infer Requirement> ? Requirement
  : never

const Checked = AgentAction.make("agent/test/LayerRequirements", {
  payload: {},
  output: Schema.String,
  seat: "anthropic:test-model",
  prompt: () => "Check the composition."
})

describe("agent layer requirements", () => {
  it("requires budget accounting and quota classification at both composition seams", () => {
    type ActionRequirements = Requirements<typeof Checked.layer>
    type AgentRequirements = Requirements<typeof Agent.layer>

    expectTypeOf<Budget.Budget extends ActionRequirements ? true : false>().toEqualTypeOf<true>()
    expectTypeOf<QuotaPolicy.QuotaClassifier extends ActionRequirements ? true : false>().toEqualTypeOf<true>()
    expectTypeOf<Budget.Budget extends AgentRequirements ? true : false>().toEqualTypeOf<true>()
    expectTypeOf<QuotaPolicy.QuotaClassifier extends AgentRequirements ? true : false>().toEqualTypeOf<true>()
    expect(Checked.layer).toBeDefined()
  })

  // The completion brake never falls back, so a host that binds no Jev must
  // not compile rather than run a loop whose sixth brake is off. The
  // requirement has to reach both seams a host composes against: `Agent.run`
  // through `Agent.Service`, and an action's layer through `AgentAction`.
  it("requires an evaluator at both composition seams, so no host runs a loop nothing can judge", () => {
    type ActionRequirements = Requirements<typeof Checked.layer>

    type RunRequirements = ReturnType<Agent.Service["run"]> extends
      Stream.Stream<infer _A, infer _E, infer Requirement> ? Requirement : never

    expectTypeOf<Evaluator.Evaluator extends ActionRequirements ? true : false>().toEqualTypeOf<true>()
    expectTypeOf<Evaluator.Evaluator extends RunRequirements ? true : false>().toEqualTypeOf<true>()
  })
})
