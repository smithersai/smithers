import { EventEmitter } from "node:events";
import { Effect } from "effect";
import type { SmithersEvent } from "@smithers/observability/SmithersEvent";
import type { CorrelationContext } from "@smithers/observability/correlation";
type CorrelatedSmithersEvent = SmithersEvent & {
    correlation?: CorrelationContext;
};
export declare class EventBus extends EventEmitter {
    private seq;
    private logDir?;
    private db?;
    private persistTail;
    private persistError;
    constructor(opts: {
        db?: any;
        logDir?: string;
        startSeq?: number;
    });
    emitEvent(event: SmithersEvent): Effect.Effect<void, unknown, never>;
    emitEventWithPersist(event: SmithersEvent): Effect.Effect<void, unknown, never>;
    emitEventQueued(event: SmithersEvent): Promise<void>;
    flush(): Effect.Effect<void, import("smithers").SmithersError, never>;
    persist(event: CorrelatedSmithersEvent): Effect.Effect<void, unknown, never>;
    private emitAndTrack;
    private enqueuePersist;
    private persistDb;
    private callDbPersistence;
    private persistLog;
    private attachCorrelation;
    private eventLogAnnotations;
}
export {};
