import { Schema } from "effect";
import type { FormHints } from "../flow-form.vibe";
/**
 * The input schemas an operation may declare: anything that decodes from
 * unknown without asking the host for a service, so every host decodes a
 * call's input on its own.
 */
export type OperationPayload = Schema.Top & Schema.ConstraintDecoder<unknown, never>;
/**
 * The catalog, requirement and confirmation rules around one operation.
 *
 * `Capability` and `Host` are the host-service and host-kind vocabularies of
 * the runtime that registers the operation; a host-neutral declaration names
 * neither.
 */
export interface OperationMetadata<Capability extends string = string, Host extends string = string> {
    readonly summary: string;
    readonly agent?: "run" | "confirm" | "never";
    readonly visibility?: "core" | "advanced" | "in-card" | "hidden";
    readonly actors?: ReadonlyArray<"person" | "app_agent" | "external_agent">;
    readonly credentialScope?: "read:user" | "write:user" | "read:repository" | "write:repository" | "read:workspace" | "write:workspace";
    readonly minimumRole?: "member" | "maintainer" | "owner";
    readonly slash?: string | null;
    readonly cli?: ReadonlyArray<string> | null;
    readonly journey?: ReadonlyArray<string>;
    readonly group?: string;
    readonly client?: {
        readonly kind: "issue-draft";
        readonly http: {
            readonly method: "POST";
            readonly path: string;
        };
    };
    readonly http?: {
        readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
        readonly path: string;
        readonly body?: Readonly<Record<string, string>>;
        readonly defaults?: Readonly<Record<string, unknown>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly objects?: Readonly<Record<string, {
            readonly when: string;
            readonly body: Readonly<Record<string, string>>;
            readonly defaults?: Readonly<Record<string, unknown>>;
        }>>;
    } | null;
    /** Not listed in the slash menu (id-scoped button actions); still invocable. */
    readonly hidden?: boolean;
    /** Teach a hidden control to the model without adding it to the human menu. */
    readonly discloseToAgent?: boolean;
    /**
     * The slash argument hint, e.g. `<number> [owner/repo]`. Its presence is
     * what makes `/name <text>` parse as an invocation rather than a prompt;
     * the text itself is catalog copy for the human and the model.
     */
    readonly args?: string;
    readonly requires?: ReadonlyArray<string>;
    /** Extra prerequisites for a payload variant of this same operation. */
    readonly payloadRequires?: (payload: Readonly<Record<string, unknown>>) => ReadonlyArray<string>;
    /** Host services this operation needs; a host without them does not register it. */
    readonly runtime?: ReadonlyArray<Capability>;
    /**
     * Host services of which at least ONE must be present. An operation that
     * serves two hosts names both; `runtime` alone cannot say "either".
     */
    readonly runtimeAny?: ReadonlyArray<Capability>;
    /**
     * The host kinds this operation exists on; absent means every host. Unlike
     * `runtime`, a missing host satisfies nothing: no host, no operation.
     */
    readonly hosts?: ReadonlyArray<Host>;
    /**
     * The repository flow this door launches; a repository leaf names itself.
     */
    readonly workflow?: string;
    /**
     * A consequential act the MODEL may ask for but never perform: a model
     * invocation does not run the handler; it posts a confirmation whose button
     * runs the operation as the user. The string is the human-readable label of
     * the act ("land pull request #12"). User invocations are unaffected.
     *
     * The function form decides per decoded payload: the label when THIS
     * invocation needs the human's confirmation, undefined when the handler may
     * run for the model as it stands.
     */
    readonly confirm?: string | ((payload: Record<string, unknown>) => string | undefined);
    /**
     * The sentence the confirmation asks, when "Smithers wants to <label>" is
     * not what happened. Absent keeps the model's sentence.
     */
    readonly confirmQuestion?: string;
    /**
     * The slash line the confirmation carries, when the raw one the model typed
     * would not name the act. An operation whose bare form resolves an implicit
     * target ("the active repository") resolves it at ASK time and returns it
     * here, so the button runs the act the confirmation described.
     */
    readonly confirmArgs?: (payload: Record<string, unknown>) => string | undefined;
    /**
     * Why a user-only operation is the human's alone: the gesture is physically
     * theirs, or the answer is theirs to give. The model's refusal quotes it.
     */
    readonly agentReason?: string;
    /**
     * THE FORM LAW: what the operation says about the form a missing-input
     * invocation renders. The fields derive from the input schema
     * (`flow-form.ts`); an operation with no hints still gets a derived form.
     */
    readonly form?: FormHints;
}
/** One declared act: its name and typed input beside its rules, with no handler. */
export interface Operation<I extends OperationPayload = OperationPayload, Capability extends string = string, Host extends string = string> extends OperationMetadata<Capability, Host> {
    readonly name: string;
    readonly input: I;
}
/**
 * Declares one operation. The literal type is kept, so a host binding reads
 * the exact input schema and only the rules the declaration states.
 */
export declare const operation: <const O extends Operation>(declared: O) => Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, keyof O> & O & {
    readonly agent: "run" | "confirm" | "never";
};
/** The input of an operation that takes nothing. */
export declare const NoInput: Schema.$Record<Schema.String, Schema.Never>;
/** The person-only raw API door shared by app and command hosts. */
export declare const debugApiOperation: Omit<{
    slash: null;
    cli: null;
    http: null;
    journey: ReadonlyArray<string>;
    group: string;
    visibility: "hidden" | "in-card";
    actors: readonly ["person"] | readonly ["person", "app_agent"];
    minimumRole: "member";
    credentialScope: "write:repository";
}, "actors" | "agent" | "agentReason" | "args" | "cli" | "group" | "http" | "input" | "minimumRole" | "name" | "summary" | "visibility"> & {
    readonly name: "debug-api";
    readonly cli: readonly ["debug", "api"];
    readonly http: {
        readonly method: "GET";
        readonly path: "/api/commands/debug-api";
        readonly body: {};
    };
    readonly visibility: "advanced";
    readonly group: "debug";
    readonly actors: readonly ["person"];
    readonly minimumRole: "member";
    readonly agent: "never";
    readonly summary: "Call the documented API";
    readonly args: "[operationId]";
    readonly agentReason: "raw API bypasses flow typing and approvals; agents use flows";
    readonly input: Schema.Struct<{
        readonly operationId: Schema.optional<Schema.String>;
        readonly intent: Schema.optional<Schema.Literals<readonly ["open", "send", "confirm"]>>;
        readonly values: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
        readonly confirmation: Schema.optional<Schema.String>;
    }>;
} & {
    readonly agent: "run" | "confirm" | "never";
};
