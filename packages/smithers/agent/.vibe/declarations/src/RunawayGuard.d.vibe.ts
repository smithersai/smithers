/**
 * The facts a guard parks a run on, and the failure Stop settles it with.
 *
 * Two kinds of guard park a run for an operator's Continue or Stop. A
 * {@link module:Budget.BudgetExceeded} is a `Runaway` run: it would spend past
 * an approved token, USD, or latency ceiling. A {@link Timeout} is a `Stuck` run:
 * one model call, tool call, or cell ran past its time limit. Both park
 * through {@link module:Budget.Parking}, on one control approval request whose
 * {@link incident} facts are frozen when the guard trips, so a restarted host
 * presents and decides the incident it was made on instead of measuring it
 * again. Approve is Continue with the recorded allowance; deny is Stop.
 *
 * @since 1.0.0-rc.1
 */
import type { ControlFacts } from "@smthrs/control";
import { FlowRuntime } from "@smthrs/flow";
import * as HarnessError from "@smthrs/harness/HarnessError";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Budget from "../../../src/Budget.ts";
/**
 * The operation a {@link Timeout} interrupted: a model call past its call
 * limit, a tool call past its call limit (including a command's own timeout
 * and a child await still running), or a cell past its wall-clock limit.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export declare const TimeoutSource: Schema.Literals<readonly ["model-call", "tool-call", "cell"]>;
declare const Timeout_base: Schema.Class<Timeout, Schema.TaggedStruct<"flows/agent/Timeout", {
    readonly source: Schema.Literals<readonly ["model-call", "tool-call", "cell"]>;
    readonly subject: Schema.String;
    readonly limitMillis: Schema.optional<Schema.Number>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * One operation that ran past its time limit.
 *
 * `subject` is the operation's replay-stable identity, so Continue and Stop
 * answer the same operation on every re-drive. `limitMillis` is absent when
 * the operation reported its own timeout without saying its limit.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export declare class Timeout extends Timeout_base {
}
/**
 * The decoded form of {@link ControlFacts.GuardIncident}.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Incident = typeof ControlFacts.GuardIncident.Type;
/**
 * The facts one tripped guard parks its run on. `allowance` is what Continue
 * authorizes: for a budget, the raised ceiling `raised` proposes; for a
 * timeout, one more run of the operation under its limit.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export declare const incident: (tripped: Budget.BudgetExceeded | Timeout, raised?: number) => Incident;
/**
 * The failure a Stop settles a parked run with: the incident it stopped, as a
 * model failure the run cannot retry past.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export declare const stopped: (facts: Incident) => HarnessError.HarnessError;
/**
 * The tag a Stop's cause carries, so the run's fault reads as a person's
 * stop rather than as the model wrapper around it.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const stoppedTag = "flows/agent/RunawayGuard/Stopped";
/**
 * The tag a {@link callLimitExceeded} failure's cause carries, so the run's
 * fault names the host's command bound rather than the model wrapper around
 * it. A product reads it as "a command ran past the limit".
 *
 * @category constants
 * @since 1.0.0
 */
export declare const callLimitTag = "flows/agent/RunawayGuard/CallLimit";
/**
 * The failure a host's command bound ends its run with: one shell or test
 * command ran `limitMillis` and was killed with its process group. Unlike a
 * command's own `timeoutMs`, which the cell reads and can work around, the
 * host's bound ends the run, as a model failure the run cannot retry past.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const callLimitExceeded: (flow: string, limitMillis: number) => HarnessError.HarnessError;
/**
 * Bounds every drive of one registered flow by a tool-call limit.
 *
 * A module flow a host runs as a step, such as `coding/PreparePlan`, is not a
 * cell call, so neither the sandbox's call limit nor the harness's `tool-call`
 * guard reaches it, and only the run's task budget bounds it (#2279). This
 * layer wraps the registration of the flow named `flowName`: each drive of an
 * execution is admitted through {@link module:Budget.Parking} and runs under
 * `limitMillis`, and a drive that runs past it is interrupted and parks the
 * run on a `Stuck` `tool-call` {@link incident} whose subject is the flow and
 * its execution. Continue drives it again under a fresh limit, with its
 * settled steps replayed; Stop fails it with {@link stopped} before it runs
 * again. A drive is bounded, not the execution: a flow that suspends on a
 * person, an approval or a timer is not charged the wait. Under a budget
 * that does not park, the flow runs unbounded, as it did before.
 *
 * Provide it to the layer that registers the flow; every other registration
 * passes through unchanged.
 *
 * @category layers
 * @since 1.0.0-rc.1
 */
export declare const layerFlowLimit: (flowName: string, limitMillis: number) => Layer.Layer<FlowRuntime.FlowRuntime, never, FlowRuntime.FlowRuntime>;
export {};
