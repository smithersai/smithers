import { Interpreter } from "@smthrs/flow"
import Rollout, { Execute, execute } from "./flow.ts"
import type { RolloutHost } from "./runtime.ts"

/** Supply an exclusively leased host per run. The returned receipt is the existing run output. */
export const executionLayer = (host: RolloutHost) =>
  Interpreter.layerWithImplementations(
    Rollout,
    Execute.toLayer(() => execute(host), { implementationVersion: "rollout/v2" })
  )
