/**
 * Stable source-parity failures:
 * `packages/testing/test/support/ParityManifest.ts`.
 */
import { CancelRequestFailed, FlowCycleDetected } from "@smthrs/flow/FlowRuntime"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as TestingError from "../src/TestingError.vibe"

describe("TestingError.Code", () => {
  const errors = {
    engine_unavailable: new TestingError.EngineUnavailableError({ message: "unavailable" }),
    execution_conflict: new TestingError.ExecutionConflictError({
      executionId: "run-1",
      field: "flow",
      expected: "a",
      actual: "b"
    }),
    capability_contract_violation: new TestingError.CapabilityContractError({
      capability: "interrupt",
      operation: "interrupt"
    }),
    conformance_skipped: new TestingError.ConformanceSkipped({
      pin: "interrupt",
      capability: "interrupt",
      reason: "unsupported"
    }),
    capability_operation_failed: new TestingError.CapabilityOperationError({
      capability: "interrupt",
      operation: "interrupt",
      message: "failed"
    }),
    transaction_commit_failed: new TestingError.TransactionCommitError({ boundary: "frame" }),
    rewind_failed: new TestingError.RewindFailureError({
      executionId: "run-1",
      frame: 1,
      boundary: "load-frame"
    }),
    flow_hash_mismatch: new TestingError.FlowHashMismatchError({
      executionId: "run-1",
      expectedFlowHash: "a",
      actualFlowHash: "b",
      expectedImportHash: "c",
      actualImportHash: "d"
    }),
    flow_cycle_detected: new FlowCycleDetected({ path: ["run-1", "run-2", "run-1"] }),
    cancel_request_failed: new CancelRequestFailed({
      code: "cancel_request_failed",
      executionId: "run-1",
      reason: "storage unavailable"
    }),
    unsafe_interrupt_unsupported: new CancelRequestFailed({
      code: "unsafe_interrupt_unsupported",
      executionId: "run-1",
      reason: "unsupported"
    })
  } satisfies Record<TestingError.EngineSubjectError["code"], TestingError.EngineSubjectError>

  it.each(Object.values(errors))("decodes engine subject code $code", (error) => {
    const code: TestingError.Code = error.code
    expect(Schema.decodeUnknownSync(TestingError.Code)(code)).toBe(code)
  })

  it.each(["task_timeout", "ralph_max_reached"])("rejects reserved code %s", (code) => {
    expect(() => Schema.decodeUnknownSync(TestingError.Code)(code)).toThrow()
  })

  it.each(["TaskTimeoutError", "RalphMaxReachedError"])("does not export reserved error %s", (name) => {
    expect(TestingError).not.toHaveProperty(name)
  })
})
