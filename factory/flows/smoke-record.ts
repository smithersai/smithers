/** Validates Schema.Record success encoding for wave flows. */
import * as Schema from "effect/Schema"
import * as path from "node:path"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { REPORTS_DIR, runFlow, ShellTask } from "./harness.ts"

const logDir = path.join(REPORTS_DIR, "smoke")
const Rec = Flow.make("factory/SmokeRecord", {
  payload: { run: Schema.String },
  success: Schema.Record(Schema.String, Schema.Unknown),
  body: () =>
    Node.all(
      Object.fromEntries(
        ["x", "y"].map((id) => [
          id,
          ShellTask.call({
            id,
            command: "printf",
            args: [`${id}\\n`],
            cwd: ".",
            timeoutMs: 30_000,
            logDir
          })
        ])
      )
    )
})
const result = await runFlow(Rec, { run: "r1" }, `smoke-record-${process.pid}`)
console.log(JSON.stringify(result))
