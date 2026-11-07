declare const CreateRefused_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "CreateRefused";
} & Readonly<A>;
/**
 * The forge didn't create, move or sync a branch: one of that name exists (`exists`), it has no such repository or
 * start (`not_found`), it can't write branches here (`not_configured`: GitHub read with no credential), the provider
 * denied the write (`forbidden`: HTTP 401/403), or it didn't answer (`unavailable`).
 */
export declare class CreateRefused extends CreateRefused_base<{
    readonly code: "exists" | "not_found" | "not_configured" | "forbidden" | "unavailable";
    readonly errorTag?: string;
    readonly errorCode?: string;
    readonly errorStatus?: number;
}> {
}
export {};
