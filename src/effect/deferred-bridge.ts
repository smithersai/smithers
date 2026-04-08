import * as DurableClock from "@effect/workflow/DurableClock";
import * as DurableDeferred from "@effect/workflow/DurableDeferred";
import * as Workflow from "@effect/workflow/Workflow";
import * as WorkflowEngine from "@effect/workflow/WorkflowEngine";
import { Effect, Exit, Layer, Schema, Scope } from "effect";

export const DeferredBridgeWorkflow = Workflow.make({
  name: "SmithersDeferredBridge",
  payload: { executionId: Schema.String },
  success: Schema.Unknown,
  idempotencyKey: ({ executionId }) => executionId,
});

let deferredEngineScope: Scope.CloseableScope | undefined;
let deferredEngineContextPromise: Promise<any> | undefined;

const buildDeferredEngineContext = async () => {
  deferredEngineScope = await Effect.runPromise(Scope.make());
  return Effect.runPromise(
    Layer.buildWithScope(WorkflowEngine.layerMemory, deferredEngineScope),
  );
};

const getDeferredEngineContext = async () => {
  if (!deferredEngineContextPromise) {
    deferredEngineContextPromise = buildDeferredEngineContext().catch((error) => {
      deferredEngineContextPromise = undefined;
      deferredEngineScope = undefined;
      throw error;
    });
  }
  return deferredEngineContextPromise;
};

const approvalDeferredSuccessSchema = Schema.Struct({
  approved: Schema.Boolean,
  note: Schema.NullOr(Schema.String),
  decidedBy: Schema.NullOr(Schema.String),
});

export type ApprovalDeferredResolution = Schema.Schema.Type<
  typeof approvalDeferredSuccessSchema
>;

export type DeferredResolution = Exit.Exit<
  ApprovalDeferredResolution | void,
  never
>;

const deferredResolutions = new Map<string, DeferredResolution>();

export const makeApprovalDeferred = (nodeId: string) =>
  DurableDeferred.make(nodeId, { success: approvalDeferredSuccessSchema });

export const makeTimerDeferred = (nodeId: string) => DurableDeferred.make(nodeId);

export const makeDeferredBridgeKey = (
  runId: string,
  nodeId: string,
  iteration: number,
): string =>
  ["smithers-deferred-bridge", runId, nodeId, String(iteration)].join(":");

export const bridgeApprovalResolve = (
  runId: string,
  nodeId: string,
  iteration: number,
  decision: { approved: boolean },
) => {
  deferredResolutions.set(
    makeDeferredBridgeKey(runId, nodeId, iteration),
    Exit.succeed({
      approved: decision.approved,
      note: null,
      decidedBy: null,
    }),
  );
};

export const bridgeTimerResolve = (
  runId: string,
  nodeId: string,
  iteration: number,
) => {
  deferredResolutions.set(
    makeDeferredBridgeKey(runId, nodeId, iteration),
    Exit.void,
  );
};

export const getDeferredResolution = (
  runId: string,
  nodeId: string,
  iteration: number,
) => deferredResolutions.get(makeDeferredBridgeKey(runId, nodeId, iteration));
