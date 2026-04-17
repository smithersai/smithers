import type { z } from "zod";

import type { SEMANTIC_TOOL_NAMES } from "./semantic-tools.js";
import type { SemanticToolCallResult } from "./SemanticToolCallResult.ts";

export type SemanticToolDefinition = {
    name: (typeof SEMANTIC_TOOL_NAMES)[number];
    description: string;
    inputSchema: z.ZodTypeAny;
    outputSchema: z.ZodTypeAny;
    annotations: Record<string, boolean>;
    handler: (input: any) => Promise<SemanticToolCallResult>;
};
