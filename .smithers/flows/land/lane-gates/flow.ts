/**
 * `land/lane-gates`: the pre-push gates for a lane that lands on `main`.
 *
 * Runs `lane-gates.sh` with bash. `gate`, in a lane worktree rebased onto
 * `origin/main`, fails on any failing test name absent from main's baseline
 * (`$HOME/lanes/main-baseline-failures.txt`), on unformatted Go and on root
 * ESLint findings in touched files. `baseline`, on a checkout of main, writes
 * that baseline; only the baseline runner (`LANE=fr-baseline-main`) may.
 * `integration` fails when HEAD drops lines main added since `base`, except in
 * files deleted under an `allowDeleted` glob.
 *
 * ```sh
 * smthrs flow start land/lane-gates --data '{"mode":"gate"}' --wait
 * smthrs flow start land/lane-gates --data '{"mode":"integration","base":"<merge-base>","allowDeleted":["docs/**"]}' --wait
 * ```
 *
 * Environment: `LANE` names the log `$HOME/lanes/<lane>.gates.log`;
 * `SMITHERS_TEST_DATABASE_URL` or `FR_PG_PORT` the PostgreSQL the database
 * tests require; `LANE_GATES_GO_P` the Go test parallelism.
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

/**
 * One mode of `lane-gates.sh`. `base` and `allowDeleted` belong to
 * `integration`; the script refuses an integration run without a base.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  mode: Schema.Literals(["gate", "baseline", "integration"]),
  base: Schema.optionalKey(Schema.NonEmptyString),
  allowDeleted: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
})

const implementationVersion = "land/lane-gates/v2"

/**
 * Runs `lane-gates.sh`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Gates = Action.make("land/lane-gates/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `lane-gates.sh` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> =>
  request.mode === "gate"
    ? []
    : request.mode === "baseline"
    ? ["--baseline"]
    : [
      "--integration",
      ...(request.base === undefined ? [] : [request.base]),
      ...(request.allowDeleted ?? []).flatMap((glob) => ["--allow-deleted", glob])
    ]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Gates.toLayer(
  (request) => runModule(new URL("../lane-gates.sh", import.meta.url), argv(request), { interpreter: "bash" }),
  { implementationVersion }
)

export default Flow.make("land/lane-gates", {
  description:
    "Run a lane's pre-push gates against main's failure baseline, record that baseline, or check integration.",
  capabilities: [
    "fs:read:**",
    "fs:write:**",
    "proc:spawn:bash *",
    "proc:spawn:git *",
    "proc:spawn:node *",
    "proc:spawn:go *",
    "proc:spawn:gofmt *",
    "proc:spawn:pnpm *",
    "proc:spawn:bun *",
    "proc:spawn:cargo *",
    "proc:spawn:psql *",
    "proc:spawn:pg_isready *",
    "proc:spawn:smthrs *",
    "net:get:**",
    "net:private:**"
  ],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Gates.call(request))
})
