import type { AgentCliActionKind } from "./AgentCliActionKind";
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function asString(value: unknown): string | undefined;
export declare function asNumber(value: unknown): number | undefined;
export declare function truncate(value: string, maxLength?: number): string;
export declare function toolKindFromName(name: string | undefined, extraRules?: ReadonlyArray<readonly [string[], AgentCliActionKind]>): AgentCliActionKind;
export declare function isLikelyRuntimeMetadata(value: string): boolean;
export declare function shouldSurfaceUnparsedStdout(line: string): boolean;
export declare function createSyntheticIdGenerator(): (prefix: string) => string;
