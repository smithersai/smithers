import { Layer } from "effect";
import { CorrelationContextService } from "./CorrelationContextService.js";
import { correlationContextToLogAnnotations } from "./correlationContextToLogAnnotations.js";
import { getCurrentCorrelationContextEffect } from "./getCurrentCorrelationContextEffect.js";
import { withCorrelationContext } from "./withCorrelationContext.js";
/** @type {Layer.Layer<CorrelationContextService, never, never>} */
export const CorrelationContextLive = Layer.succeed(CorrelationContextService, {
    current: () => getCurrentCorrelationContextEffect(),
    withCorrelation: (patch, effect) => withCorrelationContext(effect, patch),
    toLogAnnotations: correlationContextToLogAnnotations,
});
