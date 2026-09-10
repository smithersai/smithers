/**
 * Smoke test for the factory harness: two parallel ShellTask steps through
 * `Node.all` on the in-memory engine. Run with `bun factory/flows/smoke.ts`.
 */
import * as Schema from "effect/Schema"
import * as path from "node:path"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { REPORTS_DIR, runFlow, ShellTask, TaskResult } from "./harness.ts"

const logDir = path.join(REPORTS_DIR, "smoke")

const Smoke = Flow.make("factory/Smoke", {
  payload: { run: Schema.String },
  success: Schema.Struct({ a: TaskResult, b: TaskResult }),
  body: () =>
    Node.all({
      a: ShellTask.call({
        id: "echo-a",
        command: "bun",
        args: ["-e", "console.log('smoke-a'); await Bun.sleep(1000)"],
        cwd: ".",
        timeoutMs: 30_000,
        logDir
      }),
      b: ShellTask.call({
        id: "echo-b",
        command: "printf",
        args: ["smoke-b\\n"],
        cwd: ".",
        timeoutMs: 30_000,
        logDir
      })
    })
})

const result = await runFlow(Smoke, { run: "smoke-1" }, `smoke-${process.pid}`)
console.log(JSON.stringify(result, null, 2))
