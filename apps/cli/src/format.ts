/**
 * Format a timestamp as relative age: "2m ago", "1h ago", "3d ago"
 */
export declare function formatAge(ms: number): string;
/**
 * Format elapsed time compactly: "5m 23s", "1h 2m", "45s"
 */
export declare function formatElapsedCompact(startMs: number, endMs?: number): string;
/**
 * Format an elapsed time as HH:MM:SS from a base timestamp.
 */
export declare function formatTimestamp(baseMs: number, eventMs: number): string;
/**
 * Format an elapsed time as a signed relative offset:
 * +MM:SS.mmm (or +HH:MM:SS.mmm when hours > 0).
 */
export declare function formatRelativeOffset(baseMs: number, eventMs: number): string;
export declare function colorizeEventText(type: string, text: string): string;
export type FormatEventLineOptions = {
    includeTimestamp?: boolean;
    truncatePayloadAt?: number;
};
/**
 * Format a single event from _smithers_events into a log line.
 */
export declare function formatEventLine(event: {
    timestampMs: number;
    type: string;
    payloadJson: string;
}, baseMs: number, options?: FormatEventLineOptions): string;
