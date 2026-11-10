import { describe, expect, it } from "vitest"
import { Dev } from "../src/Dev.vibe"
import * as Exec from "../src/Exec.ts"
import { ToolRun } from "../src/ToolRun.ts"
import { plannedCalls } from "./plan.ts"

describe("Dev lifetime", () => {
  it("plans an unbounded exec while ordinary batch commands retain the default deadline", () => {
    const attrs = { command: "node", args: ["watch.mjs"], inputs: [], deps: [], cwd: "." }
    const service = plannedCalls(Dev({ ...attrs, readyWhen: null }))[0]!
    const batch = plannedCalls(ToolRun(attrs))[0]!
    expect(service.action).toBe("smithers-build/exec")
    expect(Exec.Payload.make(service.payload as never).timeoutMs).toBe("unbounded")
    expect(Exec.Payload.make(batch.payload as never).timeoutMs).toBe(Exec.defaultTimeoutMs)
  })
})
