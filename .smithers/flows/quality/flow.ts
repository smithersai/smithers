/**
 * Repository quality snapshot; run data remains under `.flows/quality/`.
 * From the root: `GITHUB_TOKEN=$(gh auth token) node .smithers/flows/quality/run.mjs`.
 * On a host with the native helper: `GITHUB_TOKEN=$(gh auth token) pnpm exec smthrs flow start quality --root . --wait`.
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../automation/run-module.ts"

const implementationVersion = "quality/v1"
const Request = Schema.Struct({})

const Measure = Action.make("quality/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * Runs the read-only GitHub import through the repository automation host.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer = Measure.toLayer(
  () => runModule(new URL("./run.mjs", import.meta.url), []),
  { implementationVersion }
)

export default Flow.make("quality", {
  description:
    "Import 26 UTC weeks of request lead time and source coverage; use main red time when paperwork exceeds 40%.",
  capabilities: [
    "fs:read:**",
    "fs:write:.flows/quality/**",
    "proc:spawn:node *",
    "proc:spawn:jj *",
    "net:get:https://api.github.com/**",
    "net:post:https://api.github.com/graphql"
  ],
  effects: {
    reads: ["**"],
    writes: [".flows/quality/**"],
    mode: "expected",
    onConflict: "serialize",
    tier: "irreversible"
  },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Measure.call(request))
})
