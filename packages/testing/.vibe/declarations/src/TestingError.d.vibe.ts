/**
 * Typed failures raised by testing and conformance operations.
 *
 * Every error carries a stable `code` drawn from a closed literal union, so
 * consumers can match on codes without parsing messages. The per-error code
 * schemas and the combined {@link Code} union are exported.
 *
 * Governing design: `packages/testing/docs/concepts/typed-failures.md`.
 *
 * Every literal uses `snake_case`.
 *
 * @since 0.0.0
 */
import { CancelRequestFailed, FlowCycleDetected } from "@smthrs/flow/FlowRuntime";
import * as Schema from "effect/Schema";
/**
 * The runtime grading schemas and error class, re-exported with their original
 * names and constructor identity for test consumers.
 *
 * @since 0.0.0
 * @category errors
 */
export { InvalidScoreSample, ScoreGateCode, ScoreGateError } from "@smthrs/scorers/ScoreGate";
/**
 * Codes raised by plan assertions.
 *
 * @since 0.0.0
 * @category codes
 */
export declare const PlanAssertionCode: Schema.Literals<readonly ["missing_node", "node_count_mismatch", "key_mismatch", "placement_mismatch", "declared_effect_mismatch", "envelope_mismatch", "missing_edge", "unexpected_edge", "coverage_mismatch", "snapshot_mismatch", "key_golden_mismatch", "purity_violation", "input_decode_failed"]>;
/**
 * The decoded form of {@link PlanAssertionCode}.
 *
 * @since 0.0.0
 * @category codes
 */
export type PlanAssertionCode = typeof PlanAssertionCode.Type;
/**
 * Codes raised by journal assertions.
 *
 * @since 0.0.0
 * @category codes
 */
export declare const JournalAssertionCode: Schema.Literals<readonly ["step_not_executed", "execution_order_mismatch", "terminal_status_mismatch", "effect_not_executed", "effect_kind_mismatch", "effect_journaled_more_than_once", "missing_idempotency_key", "idempotency_key_mismatch"]>;
/**
 * The decoded form of {@link JournalAssertionCode}.
 *
 * @since 0.0.0
 * @category codes
 */
export type JournalAssertionCode = typeof JournalAssertionCode.Type;
/**
 * Every stable code any testing error can carry, as one closed union.
 *
 * @since 0.0.0
 * @category codes
 */
export declare const Code: Schema.Union<readonly [Schema.Literals<readonly ["missing_node", "node_count_mismatch", "key_mismatch", "placement_mismatch", "declared_effect_mismatch", "envelope_mismatch", "missing_edge", "unexpected_edge", "coverage_mismatch", "snapshot_mismatch", "key_golden_mismatch", "purity_violation", "input_decode_failed"]>, Schema.Literals<readonly ["step_not_executed", "execution_order_mismatch", "terminal_status_mismatch", "effect_not_executed", "effect_kind_mismatch", "effect_journaled_more_than_once", "missing_idempotency_key", "idempotency_key_mismatch"]>, Schema.Literals<readonly ["invalid_threshold", "invalid_score", "mean_below_threshold", "min_below_threshold", "case_below_threshold"]>, Schema.withConstructorDefault<Schema.Literal<"flow_cycle_detected">>, Schema.Literals<readonly ["cancel_request_failed", "unsafe_interrupt_unsupported"]>, Schema.Literals<readonly ["conformance_violation", "unscripted_model", "fixture_not_encodable", "replay_harness_mismatch", "fixture_divergence", "exactly_once_unsupported", "capability_contract_violation", "conformance_skipped", "engine_unavailable", "execution_conflict", "capability_operation_failed", "transaction_commit_failed", "rewind_failed", "flow_hash_mismatch"]>]>;
/**
 * The decoded form of {@link Code}.
 *
 * @since 0.0.0
 * @category codes
 */
export type Code = typeof Code.Type;
declare const PlanAssertionError_base: Schema.Class<PlanAssertionError, Schema.TaggedStruct<"PlanAssertionError", {
    readonly code: Schema.Literals<readonly ["missing_node", "node_count_mismatch", "key_mismatch", "placement_mismatch", "declared_effect_mismatch", "envelope_mismatch", "missing_edge", "unexpected_edge", "coverage_mismatch", "snapshot_mismatch", "key_golden_mismatch", "purity_violation", "input_decode_failed"]>;
    readonly message: Schema.String;
    readonly expected: Schema.optional<Schema.Unknown>;
    readonly actual: Schema.optional<Schema.Unknown>;
}>, import("effect/Cause").YieldableError>;
/**
 * An assertion failure while inspecting a flow plan.
 *
 * @since 0.0.0
 * @category errors
 */
export declare class PlanAssertionError extends PlanAssertionError_base {
}
declare const JournalAssertionError_base: Schema.Class<JournalAssertionError, Schema.TaggedStruct<"JournalAssertionError", {
    readonly code: Schema.Literals<readonly ["step_not_executed", "execution_order_mismatch", "terminal_status_mismatch", "effect_not_executed", "effect_kind_mismatch", "effect_journaled_more_than_once", "missing_idempotency_key", "idempotency_key_mismatch"]>;
    readonly message: Schema.String;
    readonly expected: Schema.optional<Schema.Unknown>;
    readonly actual: Schema.optional<Schema.Unknown>;
}>, import("effect/Cause").YieldableError>;
/**
 * An assertion failure while inspecting a flow journal.
 *
 * @since 0.0.0
 * @category errors
 */
export declare class JournalAssertionError extends JournalAssertionError_base {
}
declare const ConformanceViolation_base: Schema.Class<ConformanceViolation, Schema.TaggedStruct<"ConformanceViolation", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"conformance_violation">>;
    readonly pin: Schema.String;
    readonly message: Schema.String;
    readonly expected: Schema.optional<Schema.Unknown>;
    readonly actual: Schema.optional<Schema.Unknown>;
}>, import("effect/Cause").YieldableError>;
/**
 * A failed executable conformance pin.
 *
 * @since 0.0.0
 * @category errors
 */
export declare class ConformanceViolation extends ConformanceViolation_base {
}
declare const UnscriptedModelError_base: Schema.Class<UnscriptedModelError, Schema.TaggedStruct<"UnscriptedModelError", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"unscripted_model">>;
    readonly modelId: Schema.String;
    readonly messageCount: Schema.Number;
    readonly toolNames: Schema.$Array<Schema.String>;
}>, import("effect/Cause").YieldableError>;
/**
 * A recorded model received a request with no matching fixture.
 *
 * The fields are a bounded identity, not the request. This error is raised as
 * a defect, so a runner prints it in full: carrying the whole
 * `ModelRequestLike` put every system block, every turn of the conversation,
 * and every tool schema into CI logs and into any attached error reporter — an
 * unbounded payload for a replay double whose whole purpose is long agent
 * conversations, and one that routinely holds file contents and customer data.
 *
 * @since 0.0.0
 * @category errors
 */
export declare class UnscriptedModelError extends UnscriptedModelError_base {
}
declare const FixtureEncodingError_base: Schema.Class<FixtureEncodingError, Schema.TaggedStruct<"FixtureEncodingError", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"fixture_not_encodable">>;
    readonly path: Schema.String;
    readonly reason: Schema.Literals<readonly ["cycle", "non-plain-object", "non-finite-number", "symbol-key", "unsupported-type", "too-deep"]>;
}>, import("effect/Cause").YieldableError>;
/**
 * A value a fixture must store is not representable as canonical JSON.
 *
 * `path` names the offending value — `$.tools[0].parameters.x` — and `reason`
 * says which rule it broke, so a consumer matches on a stable code and a typed
 * field instead of parsing the prose of a bare `TypeError`.
 *
 * @since 0.0.0
 * @category errors
 */
export declare class FixtureEncodingError extends FixtureEncodingError_base {
}
declare const ReplayHarnessMismatchError_base: Schema.Class<ReplayHarnessMismatchError, Schema.TaggedStruct<"ReplayHarnessMismatchError", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"replay_harness_mismatch">>;
    readonly expected: Schema.String;
    readonly actual: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A replay harness produced output different from its recorded expectation.
 *
 * @since 0.0.0
 * @category errors
 */
export declare class ReplayHarnessMismatchError extends ReplayHarnessMismatchError_base {
}
declare const FixtureDivergenceError_base: Schema.Class<FixtureDivergenceError, Schema.TaggedStruct<"FixtureDivergenceError", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"fixture_divergence">>;
    readonly index: Schema.Number;
    readonly field: Schema.String;
    readonly expected: Schema.Unknown;
    readonly actual: Schema.Unknown;
}>, import("effect/Cause").YieldableError>;
/**
 * The first divergent field in a fixture sequence.
 *
 * @since 0.0.0
 * @category errors
 */
export declare class FixtureDivergenceError extends FixtureDivergenceError_base {
}
declare const ExactlyOnceUnsupportedError_base: Schema.Class<ExactlyOnceUnsupportedError, Schema.TaggedStruct<"ExactlyOnceUnsupportedError", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"exactly_once_unsupported">>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * Exactly-once assertions are unsupported because the assertion vocabulary must
 * not be able to lie: the engine does not provide exactly-once execution.
 *
 * @since 0.0.0
 * @category errors
 */
export declare class ExactlyOnceUnsupportedError extends ExactlyOnceUnsupportedError_base {
}
declare const CapabilityContractError_base: Schema.Class<CapabilityContractError, Schema.TaggedStruct<"CapabilityContractError", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"capability_contract_violation">>;
    readonly capability: Schema.String;
    readonly operation: Schema.String;
    readonly expectedCode: Schema.optional<Schema.String>;
    readonly actualCode: Schema.optional<Schema.String>;
}>, import("effect/Cause").YieldableError>;
/**
 * An operation violated its declared capability contract.
 *
 * When the violation is a wrong typed capability code, the expectation and the
 * observation are carried as the typed `expectedCode` / `actualCode` fields —
 * never encoded into the operation string.
 *
 * @since 0.0.0
 * @category errors
 */
export declare class CapabilityContractError extends CapabilityContractError_base {
}
declare const ConformanceSkipped_base: Schema.Class<ConformanceSkipped, Schema.TaggedStruct<"ConformanceSkipped", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"conformance_skipped">>;
    readonly pin: Schema.String;
    readonly capability: Schema.String;
    readonly reason: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A conformance pin could not run because its subject does not implement the
 * capability named by the pin.
 *
 * This is a failure, not a successful test outcome. Suite adapters may choose
 * not to register capability pins for subjects that declare a narrower
 * contract, but once a pin runs it must either assert behavior or fail with
 * this stable code.
 *
 * @since 0.0.0
 * @category errors
 */
export declare class ConformanceSkipped extends ConformanceSkipped_base {
}
declare const EngineUnavailableError_base: Schema.Class<EngineUnavailableError, Schema.TaggedStruct<"EngineUnavailableError", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"engine_unavailable">>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * The requested engine subject is unavailable for a test or conformance pin.
 *
 * @since 0.0.0
 * @category errors
 */
export declare class EngineUnavailableError extends EngineUnavailableError_base {
}
declare const ExecutionConflictError_base: Schema.Class<ExecutionConflictError, Schema.TaggedStruct<"ExecutionConflictError", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"execution_conflict">>;
    readonly executionId: Schema.String;
    readonly field: Schema.Literals<readonly ["flow", "payload"]>;
    readonly expected: Schema.String;
    readonly actual: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A `run` named an execution id that already exists, with a different flow or a
 * different payload.
 *
 * An engine that accepted the id and silently ran the *original* flow on the
 * *original* payload would give a caller no signal at all that its arguments
 * were ignored, on the seam that defines engine conformance. `expected` and
 * `actual` are bounded renderings, never the payloads themselves.
 *
 * @since 0.0.0
 * @category errors
 */
export declare class ExecutionConflictError extends ExecutionConflictError_base {
}
/**
 * Transaction commit-failure injection boundaries.
 *
 * @since 0.0.0
 * @category codes
 */
export declare const TransactionBoundary: Schema.Literals<readonly ["frame", "snapshot", "output", "attempt", "event"]>;
/**
 * The decoded form of {@link TransactionBoundary}.
 *
 * @since 0.0.0
 * @category codes
 */
export type TransactionBoundary = typeof TransactionBoundary.Type;
/**
 * Rewind boundaries at which a conformance subject can inject a failure.
 *
 * @since 0.0.0
 * @category codes
 */
export declare const RewindBoundary: Schema.Literals<readonly ["load-frame", "validate-frame", "truncate-journal", "restore-snapshot", "restore-output", "restore-attempt", "append-audit", "resume"]>;
/**
 * The decoded form of {@link RewindBoundary}.
 *
 * @since 0.0.0
 * @category codes
 */
export type RewindBoundary = typeof RewindBoundary.Type;
declare const CapabilityOperationError_base: Schema.Class<CapabilityOperationError, Schema.TaggedStruct<"CapabilityOperationError", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"capability_operation_failed">>;
    readonly capability: Schema.String;
    readonly operation: Schema.String;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A requested capability operation has no valid subject.
 *
 * @since 0.0.0
 * @category errors
 */
export declare class CapabilityOperationError extends CapabilityOperationError_base {
}
declare const TransactionCommitError_base: Schema.Class<TransactionCommitError, Schema.TaggedStruct<"TransactionCommitError", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"transaction_commit_failed">>;
    readonly boundary: Schema.Literals<readonly ["frame", "snapshot", "output", "attempt", "event"]>;
}>, import("effect/Cause").YieldableError>;
/**
 * A failure raised at an injected transactional commit boundary.
 *
 * @since 0.0.0
 * @category errors
 */
export declare class TransactionCommitError extends TransactionCommitError_base {
}
declare const RewindFailureError_base: Schema.Class<RewindFailureError, Schema.TaggedStruct<"RewindFailureError", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"rewind_failed">>;
    readonly executionId: Schema.String;
    readonly frame: Schema.Number;
    readonly boundary: Schema.Literals<readonly ["load-frame", "validate-frame", "truncate-journal", "restore-snapshot", "restore-output", "restore-attempt", "append-audit", "resume"]>;
}>, import("effect/Cause").YieldableError>;
/**
 * A failure raised at an injected frame-rewind boundary.
 *
 * @since 0.0.0
 * @category errors
 */
export declare class RewindFailureError extends RewindFailureError_base {
}
declare const FlowHashMismatchError_base: Schema.Class<FlowHashMismatchError, Schema.TaggedStruct<"FlowHashMismatchError", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"flow_hash_mismatch">>;
    readonly executionId: Schema.String;
    readonly expectedFlowHash: Schema.String;
    readonly actualFlowHash: Schema.String;
    readonly expectedImportHash: Schema.String;
    readonly actualImportHash: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * Resume was rejected because the current flow or import graph differs
 * from the stamp recorded for the execution.
 *
 * @since 0.0.0
 * @category errors
 */
export declare class FlowHashMismatchError extends FlowHashMismatchError_base {
}
/**
 * Every typed failure an engine subject (or one of its optional capabilities)
 * may raise. The conformance seam never carries an `unknown` error channel: a
 * subject that laundered a foreign cause into `unknown` could not be matched on
 * by a pin.
 *
 * `FlowCycleDetected` is re-declared here because it is part of the engine's
 * typed `execute` contract: a recoverable failure carrying the cycle `path`,
 * which pins must be able to match on rather than a stringified dump.
 * `CancelRequestFailed` is part of the engine's typed interrupt contract for
 * the same reason.
 *
 * @since 0.0.0
 * @category errors
 */
export type EngineSubjectError = EngineUnavailableError | ExecutionConflictError | CapabilityContractError | ConformanceSkipped | CapabilityOperationError | TransactionCommitError | RewindFailureError | FlowHashMismatchError | FlowCycleDetected | CancelRequestFailed;
