import { Layer } from "effect";
import { DurablePrimitivesLive } from "../durables/index.ts";
import { ExecutionServiceLive } from "../execution/index.ts";
import {
  CorrelationContextLive,
  MetricsServiceLive,
  TracingServiceLive,
} from "../observability/index.ts";
import { SchedulerLive } from "../scheduler/index.ts";
import { WorkflowSessionLive } from "../session.ts";

const ObservabilityLayer = Layer.mergeAll(
  CorrelationContextLive,
  MetricsServiceLive,
  TracingServiceLive,
);

export const SmithersCoreLayer = Layer.mergeAll(
  ObservabilityLayer,
  SchedulerLive.pipe(Layer.provide(ObservabilityLayer)),
  DurablePrimitivesLive,
  ExecutionServiceLive,
  WorkflowSessionLive,
);
