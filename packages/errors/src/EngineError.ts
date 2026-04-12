import type { EngineErrorCode } from "./EngineErrorCode.ts";
declare const EngineError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "EngineError";
} & Readonly<A>;
export declare class EngineError extends EngineError_base<{
    readonly code: EngineErrorCode;
    readonly message: string;
    readonly context?: Record<string, unknown>;
}> {
}
export {};
