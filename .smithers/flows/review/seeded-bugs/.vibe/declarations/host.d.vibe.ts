import * as Agent from "@smthrs/agent/Agent";
import * as AgentAction from "@smthrs/agent/AgentAction";
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy";
import * as Budget from "@smthrs/agent/Budget";
import * as SeatResolver from "@smthrs/agent/SeatResolver";
import { Action } from "@smthrs/flow";
import * as Evaluator from "@smthrs/model/Evaluator";
import { Layer } from "effect";
import { Crypto } from "@smthrs/crypto";
/** Builds ordinary test services without replacing review implementations. */
export declare const host: (seats: Layer.Layer<SeatResolver.SeatResolver>, budget?: Layer.Layer<Budget.Budget, Budget.ConfigurationError, never>) => Layer.Layer<Agent.Agent | Budget.Budget | import("effect/process/ChildProcessSpawner").ChildProcessSpawner | Crypto.Crypto | Evaluator.Evaluator | import("effect/FileSystem").FileSystem | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | Action.Implementations | import("effect/Path").Path | QuotaPolicy.QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | SeatResolver.SeatResolver | import("@smthrs/harness/Steering").Source, Budget.ConfigurationError | import("@smthrs/harness/Sandbox").SandboxError, never>;
/** Review against a caller-owned engine, seat resolver, budget and evaluator. */
export declare const layerMemory: (seats: Layer.Layer<SeatResolver.SeatResolver>, _environment?: Readonly<Record<string, string | undefined>>) => Layer.Layer<Agent.Agent | Budget.Budget | import("effect/process/ChildProcessSpawner").ChildProcessSpawner | Crypto.Crypto | Evaluator.Evaluator | import("effect/FileSystem").FileSystem | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | Action.Implementations | import("effect/Path").Path | QuotaPolicy.QuotaClassifier | Action.Requirement<"smithers-review/ApplyVerdicts"> | Action.Requirement<"smithers-review/FinalizeReview"> | Action.Requirement<"smithers-review/MergeFileBatch"> | Action.Requirement<"smithers-review/NarrateChanges"> | Action.Requirement<"smithers-review/PrepareReview"> | Action.Requirement<"smithers-review/RenderWalkthrough"> | Action.Requirement<"smithers-review/ReviewFile"> | Action.Requirement<"smithers-review/VerifyFindings"> | import("@smthrs/harness/Sandbox").Sandbox | SeatResolver.SeatResolver | import("@smthrs/harness/Steering").Source, Budget.ConfigurationError | import("@smthrs/harness/Sandbox").SandboxError, never>;
