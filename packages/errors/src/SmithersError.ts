import type { SmithersErrorCode } from "./SmithersErrorCode.ts";
import type { SmithersErrorOptions } from "./SmithersErrorOptions.ts";
export declare class SmithersError extends Error {
    readonly code: SmithersErrorCode;
    readonly summary: string;
    readonly docsUrl: string;
    details?: Record<string, unknown>;
    readonly cause?: unknown;
    constructor(code: SmithersErrorCode, summary: string, details?: Record<string, unknown>, causeOrOptions?: unknown | SmithersErrorOptions);
}
