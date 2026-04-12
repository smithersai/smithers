import { Effect } from "effect";
import { SmithersDb } from "@smithers/db/adapter";
import { SmithersError } from "@smithers/errors/SmithersError";
export declare function approveNode(adapter: SmithersDb, runId: string, nodeId: string, iteration: number, note?: string, decidedBy?: string, decision?: unknown, autoApproved?: boolean): Effect.Effect<void, SmithersError, never>;
export declare function denyNode(adapter: SmithersDb, runId: string, nodeId: string, iteration: number, note?: string, decidedBy?: string, decision?: unknown): Effect.Effect<void, SmithersError, never>;
