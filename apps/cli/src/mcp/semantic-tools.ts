import { z } from "zod";
import { findAndOpenDb } from "../find-db";
export declare const SEMANTIC_TOOL_NAMES: readonly ["list_workflows", "run_workflow", "list_runs", "get_run", "watch_run", "explain_run", "list_pending_approvals", "resolve_approval", "get_node_detail", "revert_attempt", "list_artifacts", "get_chat_transcript", "get_run_events"];
declare const toolErrorSchema: z.ZodObject<{
    code: z.ZodString;
    message: z.ZodString;
    details: z.ZodOptional<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    docsUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strip>;
type SemanticToolCallResult = {
    content: Array<{
        type: "text";
        text: string;
    }>;
    structuredContent: {
        ok: boolean;
        data?: unknown;
        error?: z.infer<typeof toolErrorSchema>;
    };
    isError?: boolean;
};
type SemanticToolContext = {
    cwd: () => string;
    openDb: typeof findAndOpenDb;
};
export type SemanticToolDefinition = {
    name: (typeof SEMANTIC_TOOL_NAMES)[number];
    description: string;
    inputSchema: z.ZodTypeAny;
    outputSchema: z.ZodTypeAny;
    annotations: Record<string, boolean>;
    handler: (input: any) => Promise<SemanticToolCallResult>;
};
export declare function createSemanticToolDefinitions(options?: Partial<SemanticToolContext>): SemanticToolDefinition[];
export {};
