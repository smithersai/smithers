import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { FlowEngine } from "../src/index.ts"

const flow = Flow.make("engine/Lineage", { payload: {}, success: Schema.String, body: () => Node.succeed("ready") })

describe("FlowEngine.Lineage", () => {
  it("addresses a run's root as an injective encoded tuple", () => {
    expect(FlowEngine.Lineage.root("run-1")).toBe("smithers-journal-lineage/v1:[\"run-1\"]")
    expect(FlowEngine.Lineage.root("r/root/x")).toBe("smithers-journal-lineage/v1:[\"r/root/x\"]")
    expect(FlowEngine.Lineage.root("a\",\"b")).not.toBe("smithers-journal-lineage/v1:[\"a\",\"b\"]")
    expect(FlowEngine.Lineage.root("é")).not.toBe(FlowEngine.Lineage.root("é"))
  })

  it("mints only the root lineage until a node contributes a path segment", () => {
    // No engine node contributes a segment, so a path constructor would be a
    // public API without a caller. It returns with the node that needs it.
    expect(Object.keys(FlowEngine.Lineage)).toEqual(["root"])
  })

  it("is carried on the instance a runtime hands a flow", () => {
    // The frame address `(lineageId, seq)` starts here: every durable record
    // the run writes stamps this into `meta.lineageId`.
    expect(FlowEngine.makeInstance(flow, "run-1").lineageId).toBe(FlowEngine.Lineage.root("run-1"))
  })
})
