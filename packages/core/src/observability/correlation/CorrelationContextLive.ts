import { Layer } from "effect";
import { CorrelationContextService } from "./CorrelationContextService.ts";
import { correlationContextToLogAnnotations } from "./correlationContextToLogAnnotations.ts";
import { getCurrentCorrelationContextEffect } from "./getCurrentCorrelationContextEffect.ts";
import { withCorrelationContext } from "./withCorrelationContext.ts";

export const CorrelationContextLive = Layer.succeed(CorrelationContextService, {
  current: () => getCurrentCorrelationContextEffect(),
  withCorrelation: (patch, effect) => withCorrelationContext(effect, patch),
  toLogAnnotations: correlationContextToLogAnnotations,
});
