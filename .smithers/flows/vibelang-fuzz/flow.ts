// Smithers discovers durable file flows only as flow.ts.
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { FuzzPhaseFailed, runStage } from "./run.vibe"

const version = "vibelang-fuzz/v7"
const settings = { coverage: Schema.Boolean, budget: Schema.String, browserBudget: Schema.String, seed: Schema.String, executions: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))) }
const Request = Schema.Struct(settings)
const Stage = Schema.Struct({ stage: Schema.Literals(["prepare", "build", "targets", "browser", "report"]), ...settings })
const Run = Action.make("vibelang-fuzz/stage", {
  implementationVersion: version, payload: Stage, success: Schema.Void, error: FuzzPhaseFailed, tier: "irreversible",
  capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:env E2E_4501 E2E_PORT E2E_SERVER_SECONDS FUZZ_BUDGET FUZZ_COLLECT_PARTIAL FUZZ_EXECUTIONS FUZZ_SEED NODE_OPTIONS PLAYWRIGHT_BROWSERS_PATH -- pnpm *", "net:get:**", "net:post:**", "net:private:**"],
  effects: { reads: ["**"], writes: ["apps/vibelang/**", "node_modules/.cache/**", "packages/**/*.d.vibe.ts", "packages/**/.vibelang/**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
})

/** The host runs each phase as its own recorded action; completed phases survive host recovery. */
export const layer = Run.toLayer(
  ({ stage, ...settings }) => runStage(stage, settings.coverage, settings),
  { implementationVersion: version },
)

export default Flow.make("vibelang-fuzz", {
  description: "Fuzz the VibeLang app in Effect, Chromium and workerd, retaining every regression and per-target budget receipt.",
  capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:env E2E_4501 E2E_PORT E2E_SERVER_SECONDS FUZZ_BUDGET FUZZ_COLLECT_PARTIAL FUZZ_EXECUTIONS FUZZ_SEED NODE_OPTIONS PLAYWRIGHT_BROWSERS_PATH -- pnpm *", "net:get:**", "net:post:**", "net:private:**"],
  effects: { reads: ["**"], writes: ["apps/vibelang/**", "node_modules/.cache/**", "packages/**/*.d.vibe.ts", "packages/**/.vibelang/**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request, success: Schema.Void, error: FuzzPhaseFailed,
  body: Node.capture({ version }, (settings) => {
    return Node.andThen(Run.call({ stage: "prepare", ...settings }), Node.andThen(Run.call({ stage: "build", ...settings }),
      Node.andThen(Run.call({ stage: "targets", ...settings }),
        Node.andThen(Run.call({ stage: "browser", ...settings }),
          settings.coverage ? Run.call({ stage: "report", ...settings }) : Node.succeed(undefined)))))
  }),
})
