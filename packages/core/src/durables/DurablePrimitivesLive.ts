import { Effect, Layer } from "effect";
import { DurablePrimitives } from "./DurablePrimitives.ts";

export const DurablePrimitivesLive = Layer.succeed(DurablePrimitives, {
  resolveApproval: (_nodeId, resolution) => Effect.succeed(resolution),
  receiveEvent: (eventName, payload) => Effect.succeed({ eventName, payload }),
  createTimer: (request) => Effect.succeed(request),
  continueAsNew: (transition) => Effect.succeed(transition),
});
