type TimeoutInput = number | {
    totalMs?: number;
    idleMs?: number;
} | undefined;
export declare function resolveTimeouts(timeout: TimeoutInput, fallback?: {
    totalMs?: number;
    idleMs?: number;
}): {
    totalMs?: number;
    idleMs?: number;
};
export {};
