/**
 * Turning the script the model just ran into a saved flow, as two ordinary
 * flows.
 *
 * A run that solved something once solved it as a script: a few cells that read
 * the right things, called the right boundaries, and printed an answer. The
 * only thing standing between that script and a flow anyone can call again is
 * writing it down. These two bindings are that move, split where the model has
 * to think:
 *
 * - `flows/show-script` hands the model its own turn back — the source of every
 *   cell it executed, in order — together with the rules a saved flow has to
 *   follow and the file skeleton to fill in. It reads the
 *   {@link CellHistory.CellHistory} the controller records into, so a host that
 *   keeps no history simply reports an empty script.
 * - `flows/write-flow` takes the three files that come back and writes them
 *   through a {@link FlowStore.FlowStore}. When a `Registry` is in context it is
 *   refreshed afterwards. When that registry is also passed to `Agent.run`,
 *   a successful refresh makes the new model-invocable flow appear in
 *   `ctx.flows` on the next frame. Each frame journals its catalog for replay.
 *
 * The rules and the skeleton are the host's, because the file layout a saved
 * flow lands in is the host's. {@link bestPractices} and {@link flowTemplate}
 * are this repository's, and {@link Options} is how a host with its own
 * conventions teaches those instead.
 *
 * @since 0.1.0
 */
import * as CellHistory from "@smthrs/harness/CellHistory";
import * as FlowBinding from "@smthrs/harness/FlowBinding";
import type * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as FlowStore from "../../../src/FlowStore.ts";
/**
 * What a saved flow has to get right, in the order it matters.
 *
 * This text is teaching, not documentation. The model reads it once and then
 * writes three files, so every line names a decision it is about to make.
 *
 * @category models
 * @since 0.1.0
 */
export declare const bestPractices: string;
/**
 * The `flow.ts` skeleton `flows/write-flow` expects back, filled in.
 *
 * @category models
 * @since 0.1.0
 */
export declare const flowTemplate = "\"use server\"\n\nimport { Flow } from \"@smthrs/flow\"\nimport { Node } from \"@smthrs/plan\"\nimport * as Schema from \"effect/Schema\"\n\n// Save as .smithers/flows/<id>/flow.ts; the tag must match the directory name.\nexport default Flow.make(\"<id>\", {\n  description: \"<one line naming what this flow produces>\",\n  capabilities: [],\n  effects: { reads: [], writes: [], mode: \"expected\", onConflict: \"serialize\", tier: \"irreversible\" },\n  payload: { value: Schema.String },\n  success: Schema.String,\n  // Replace this body with the saved work; declare its inputs in payload and its result in success.\n  body: Node.capture({}, (payload) => Node.succeed(payload.value))\n})\n";
/**
 * Input for `flows/show-script`.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const ShowScriptInput: Schema.Struct<{
    readonly bestPractices: Schema.optionalKey<Schema.String>;
}>;
/**
 * Output for `flows/show-script`.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const ShowScriptOutput: Schema.Struct<{
    readonly cells: Schema.$Array<Schema.Struct<{
        readonly ordinal: Schema.Number;
        readonly source: Schema.String;
    }>>;
    readonly bestPractices: Schema.String;
    readonly template: Schema.String;
}>;
/**
 * Input for `flows/write-flow`.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const WriteFlowInput: Schema.Struct<{
    readonly id: Schema.String;
    readonly description: Schema.String;
    readonly flowSource: Schema.String;
    readonly testSource: Schema.String;
    readonly fixtureJson: Schema.String;
}>;
/**
 * Output for `flows/write-flow`.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const WriteFlowOutput: Schema.Struct<{
    readonly files: Schema.$Array<Schema.String>;
    readonly warning: Schema.optionalKey<Schema.String>;
}>;
/**
 * The `flows/show-script` declaration.
 *
 * @category flows
 * @since 0.1.0
 */
export declare const showScriptFlow: {
    readonly capabilities: readonly [];
    readonly name: "flows/show-script";
    readonly description: "Return the source of every cell this turn has executed, plus the rules and the file skeleton a saved flow uses. Call it before flows/write-flow.";
    readonly input: Schema.Struct<{
        readonly bestPractices: Schema.optionalKey<Schema.String>;
    }>;
    readonly output: Schema.Struct<{
        readonly cells: Schema.$Array<Schema.Struct<{
            readonly ordinal: Schema.Number;
            readonly source: Schema.String;
        }>>;
        readonly bestPractices: Schema.String;
        readonly template: Schema.String;
    }>;
    readonly effects: {
        readonly reads: readonly [];
        readonly writes: readonly [];
        readonly mode: "expected";
        readonly onConflict: "serialize";
        readonly tier: "irreversible";
    };
};
/**
 * The authority `flows/write-flow` needs: writing files under `/.smithers/flows/`.
 *
 * @category flows
 * @since 1.0.0
 */
export declare const writeFlowCapabilities: string[];
/**
 * The `flows/write-flow` declaration.
 *
 * @category flows
 * @since 0.1.0
 */
export declare const writeFlowFlow: {
    readonly name: "flows/write-flow";
    readonly description: "Save a flow: writes flow.ts, flow.e2e.ts, and its fixture under .smithers/flows/<id>/. The id must be lowercase letters, digits, and hyphens.";
    readonly input: Schema.Struct<{
        readonly id: Schema.String;
        readonly description: Schema.String;
        readonly flowSource: Schema.String;
        readonly testSource: Schema.String;
        readonly fixtureJson: Schema.String;
    }>;
    readonly output: Schema.Struct<{
        readonly files: Schema.$Array<Schema.String>;
        readonly warning: Schema.optionalKey<Schema.String>;
    }>;
    readonly capabilities: string[];
    readonly effects: {
        readonly reads: readonly [];
        readonly writes: readonly [".smithers/flows/**"];
        readonly mode: "expected";
        readonly onConflict: "serialize";
        readonly tier: "irreversible";
    };
};
/**
 * The host's own rules and skeleton, when they differ from this repository's.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
    /** Replaces {@link bestPractices} as the rules a saved flow has to follow. */
    readonly bestPractices?: string | undefined;
    /** Replaces {@link flowTemplate} as the file skeleton the model fills in. */
    readonly template?: string | undefined;
}
/**
 * Promotion, as two ordinary flows.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const source: (services: Context.Context<CellHistory.CellHistory | FlowStore.FlowStore>, options?: Options) => FlowBinding.Source;
