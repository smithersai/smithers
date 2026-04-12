import type { SmithersDb } from "@smithers/db/adapter";
import type { HijackCandidate } from "./hijack";
export declare function persistConversationHijackHandoff(adapter: SmithersDb, candidate: HijackCandidate, messages: unknown[]): Promise<void>;
export declare function launchConversationHijackSession(adapter: SmithersDb, candidate: HijackCandidate & {
    mode: "conversation";
    messages: unknown[];
}): Promise<{
    code: number;
    messages: unknown[];
}>;
