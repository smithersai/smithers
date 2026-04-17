export type SemanticToolError = {
    code: string;
    message: string;
    details?: Record<string, unknown> | null;
    docsUrl?: string | null;
};
