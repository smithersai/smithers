import { getCurrentCorrelationContext as getCoreCurrentCorrelationContext, mergeCorrelationContext as mergeCoreCorrelationContext, } from "./_coreCorrelation/index.js";
/** @typedef {import("./_coreCorrelation/CorrelationContext.ts").CorrelationContext} CorrelationContext */
/** @typedef {import("./_coreCorrelation/CorrelationPatch.ts").CorrelationPatch} CorrelationPatch */
/** @typedef {CorrelationPatch} CorrelationContextPatch */

export { correlationContextFiberRef, correlationContextToLogAnnotations, CorrelationContextLive, CorrelationContextService, getCurrentCorrelationContext, getCurrentCorrelationContextEffect, mergeCorrelationContext, runWithCorrelationContext, withCorrelationContext, withCurrentCorrelationContext, } from "./_coreCorrelation/index.js";
/**
 * @param {CorrelationPatch} patch
 */
export function updateCurrentCorrelationContext(patch) {
    const current = getCoreCurrentCorrelationContext();
    if (!current)
        return;
    // TODO: replace this compatibility shim once legacy callers adopt the
    // Effect-returning updateCurrentCorrelationContext from @smithers-orchestrator/observability.
    const next = mergeCoreCorrelationContext(current, patch);
    if (!next)
        return;
    Object.assign(current, next);
}
