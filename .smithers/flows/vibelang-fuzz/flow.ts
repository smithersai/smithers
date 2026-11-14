// Smithers discovers durable file flows only as flow.ts.
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { FuzzPhaseFailed, runStage } from "./run.vibe"

const version = "vibelang-fuzz/v10"
const settings = {
  coverage: Schema.Boolean,
  budget: Schema.String,
  browserBudget: Schema.String,
  seed: Schema.String,
  executions: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  // `pnpm fuzz:affected` (apps/vibelang/verify/fuzz_affected.cjs): exactly each target's seeded floor, only these Vitest
  // target files, the browser phase only when it reaches a changed source, and the report over the changed sources.
  floorOnly: Schema.optionalKey(Schema.Boolean),
  targets: Schema.optionalKey(Schema.Array(Schema.String)),
  reportFiles: Schema.optionalKey(Schema.Array(Schema.String)),
  browser: Schema.optionalKey(Schema.Boolean),
  // false: the build stage runs only wiki:build, when no target runs the CLI and MCP surfaces (dist-factory).
  surfaces: Schema.optionalKey(Schema.Boolean),
  // false: no Vitest targets and no report stage, the browser phase alone (`pnpm fuzz:affected --boxes`' browser shard).
  unit: Schema.optionalKey(Schema.Boolean)
}
const Request = Schema.Struct(settings)
const Stage = Schema.Struct({
  stage: Schema.Literals(["prepare", "build", "targets", "browser", "report"]),
  ...settings
})
const Run = Action.make("vibelang-fuzz/stage", {
  implementationVersion: version,
  payload: Stage,
  success: Schema.Void,
  error: FuzzPhaseFailed,
  tier: "irreversible",
  capabilities: [
    "fs:read:**",
    "fs:write:**",
    "proc:spawn:env E2E_4501 E2E_PORT E2E_SERVER_SECONDS FUZZ_BROWSER FUZZ_BROWSER_WORKERS FUZZ_BUDGET FUZZ_COLLECT_PARTIAL FUZZ_EXECUTIONS FUZZ_FLOOR_ONLY FUZZ_REPORT_FILES FUZZ_SEED FUZZ_SHARD FUZZ_WORKERS NODE_OPTIONS PLAYWRIGHT_BROWSERS_PATH WORKERD_COVERAGE WORKERD_COVERAGE_DIR -- pnpm *",
    "net:get:**",
    "net:post:**",
    "net:private:**"
  ],
  effects: {
    reads: ["**"],
    writes: ["apps/vibelang/**", "node_modules/.cache/**", "packages/**/*.d.vibe.ts", "packages/**/.vibelang/**"],
    mode: "expected",
    onConflict: "serialize",
    tier: "irreversible"
  }
})

/** The host runs each phase as its own recorded action; completed phases survive host recovery. */
export const layer = Run.toLayer(
  ({ stage, ...settings }) => runStage(stage, settings.coverage, settings),
  { implementationVersion: version }
)

export default Flow.make("vibelang-fuzz", {
  description:
    "Fuzz the VibeLang app in Effect, Chromium and workerd, retaining every regression and per-target budget receipt.",
  capabilities: [
    "fs:read:**",
    "fs:write:**",
    "proc:spawn:env E2E_4501 E2E_PORT E2E_SERVER_SECONDS FUZZ_BROWSER FUZZ_BROWSER_WORKERS FUZZ_BUDGET FUZZ_COLLECT_PARTIAL FUZZ_EXECUTIONS FUZZ_FLOOR_ONLY FUZZ_REPORT_FILES FUZZ_SEED FUZZ_SHARD FUZZ_WORKERS NODE_OPTIONS PLAYWRIGHT_BROWSERS_PATH WORKERD_COVERAGE WORKERD_COVERAGE_DIR -- pnpm *",
    "net:get:**",
    "net:post:**",
    "net:private:**"
  ],
  effects: {
    reads: ["**"],
    writes: ["apps/vibelang/**", "node_modules/.cache/**", "packages/**/*.d.vibe.ts", "packages/**/.vibelang/**"],
    mode: "expected",
    onConflict: "serialize",
    tier: "irreversible"
  },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: FuzzPhaseFailed,
  body: Node.capture({ version }, (settings) => {
    const browser = settings.browser !== false
    const unit = settings.unit !== false
    const report = settings.coverage && unit ? Run.call({ stage: "report", ...settings }) : Node.succeed(undefined)
    return Node.andThen(
      browser ? Run.call({ stage: "prepare", ...settings }) : Node.succeed(undefined),
      Node.andThen(
        Run.call({ stage: "build", ...settings }),
        Node.andThen(
          unit ? Run.call({ stage: "targets", ...settings }) : Node.succeed(undefined),
          browser ? Node.andThen(Run.call({ stage: "browser", ...settings }), report) : report
        )
      )
    )
  })
})
