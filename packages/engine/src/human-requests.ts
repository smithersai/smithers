export declare const HUMAN_REQUEST_KINDS: readonly ["ask", "confirm", "select", "json"];
export type HumanRequestKind = (typeof HUMAN_REQUEST_KINDS)[number];
export declare const HUMAN_REQUEST_STATUSES: readonly ["pending", "answered", "cancelled", "expired"];
export type HumanRequestStatus = (typeof HUMAN_REQUEST_STATUSES)[number];
export declare function buildHumanRequestId(runId: string, nodeId: string, iteration: number): string;
export declare function isHumanTaskMeta(meta: Record<string, unknown> | null | undefined): boolean;
export declare function getHumanTaskPrompt(meta: Record<string, unknown> | null | undefined, fallback: string): string;
export declare function isHumanRequestPastTimeout(request: {
    timeoutAtMs?: number | null;
} | null | undefined, nowMs?: number): boolean;
type HumanRequestSchemaValidation = {
    ok: true;
} | {
    ok: false;
    code: "HUMAN_REQUEST_SCHEMA_INVALID" | "HUMAN_REQUEST_VALIDATION_FAILED";
    message: string;
};
export declare function validateHumanRequestValue(request: {
    requestId: string;
    schemaJson: string | null;
}, value: unknown): HumanRequestSchemaValidation;
export {};
