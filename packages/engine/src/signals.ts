import { Effect } from "effect";
import { SmithersDb } from "@smithers/db/adapter";
import { SmithersError } from "@smithers/errors/SmithersError";
export type SignalRunOptions = {
    correlationId?: string | null;
    receivedBy?: string | null;
    timestampMs?: number;
};
export declare function signalRun(adapter: SmithersDb, runId: string, signalName: string, payload: unknown, options?: SignalRunOptions): Effect.Effect<{
    runId: string;
    seq: number;
    signalName: string;
    correlationId: string | null;
    receivedAtMs: number;
}, SmithersError, never>;
