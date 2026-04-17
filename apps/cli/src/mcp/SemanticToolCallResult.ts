import type { SemanticToolError } from "./SemanticToolError.ts";

export type SemanticToolCallResult = {
    content: Array<{
        type: "text";
        text: string;
    }>;
    structuredContent: {
        ok: boolean;
        data?: unknown;
        error?: SemanticToolError;
    };
    isError?: boolean;
};
