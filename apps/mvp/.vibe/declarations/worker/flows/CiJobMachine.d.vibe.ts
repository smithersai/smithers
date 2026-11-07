import { Action } from "@smthrs/flow";
import { CiJob } from "@smthrs/sandbox";
import { Layer, Metric } from "effect";
import { Machines } from "../branch/Machines.vibe";
import type { SandboxBranch } from "../branch/Sandboxes.vibe";
/** Whom a job's commands run as in its box: a CI job has no person. */
export declare const CI_OWNER = "ci";
/** The namespace of a job's tool call ids: the version 5 UUID of `<run>:<job>:<call>`. */
export declare const CI_JOB_NAMESPACE = "6f3c0d1e-5b7a-4c8e-9a2d-1e4f6b8c0a35";
/**
 * The machine job `job` of `target`'s run runs on: one per run and job name, named by a digest of the two, of the kind
 * the job's `machine` names (the deployment's default when absent).
 */
export declare const machineOf: (target: CiJob.Target, job: CiJob.JobRef) => SandboxBranch;
/** A job's tool calls on its machine, by `call` (`checkout`, `step`, `release`) and `outcome`. */
export declare const calls: Metric.Counter<number>;
/**
 * Stops every process the job's user still has, but this command's own shell and its ancestors: a step's server or
 * watcher left in the background would keep the machine awake (worker/branch/Machine.ts `PROBE`). POSIX sh over /proc:
 * the image has no procps.
 */
export declare const STOP_LEFTOVERS: string;
/** The exit code a step records when its machine lost it: it started and never reported an end. */
export declare const LOST_EXIT_CODE = -1;
/** `CiJob.Machine` over the host's `Machines`. */
export declare const layer: Layer.Layer<CiJob.Machine, never, Machines>;
/** Registers `ci/job`, and `ci/graph` which runs many as children, over the host's `machines`. */
export declare const registration: <E, R>(machines: Layer.Layer<Machines, E, R>) => Layer.Layer<Action.Implementations | Action.Requirement<"ci/job/Checkout"> | Action.Requirement<"ci/job/Release"> | Action.Requirement<"ci/job/Step">, E, R | import("@smthrs/flow/FlowRuntime").FlowRuntime>;
