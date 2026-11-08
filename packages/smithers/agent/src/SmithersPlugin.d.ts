/**
 * Teaches an agent Smithers itself, as one ordinary cell plugin.
 *
 * The plugin contributes through the two cell hooks that already exist:
 *
 * - `cellModelRequest` appends one short {@link brief} to every model request,
 *   so the agent knows what Smithers is before it has read a file.
 * - `cellFlows` adds `smithers.guide`, the structured {@link knowledge}, and,
 *   when the host passes {@link Ports}, `smithers.flows`, `smithers.run`, and
 *   `smithers.inspect` over the host's own flow-run control path.
 *
 * A cell reaches all of them the way it reaches every capability:
 * `ctx.call("smithers.guide", { topic: "cli" })`. There is no `ctx.smithers`
 * global and no second flow model; the host's run path keeps its own
 * persistence, deduplication, approval, and active-run limit.
 *
 * @since 1.0.0-rc.1
 */
import * as FlowBinding from "@smthrs/harness/FlowBinding";
import type { FlowsHooks, FlowsPlugin } from "@smthrs/plugin";
import * as Schema from "effect/Schema";
/**
 * The plugin's name in the kernel and in the composition identity.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export declare const name = "smithers";
/**
 * One fact about a package, a command, or an authoring rule.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Fact {
    readonly name: string;
    readonly about: string;
}
/**
 * What an agent needs to know to use and extend Smithers.
 *
 * Every `cli` entry is a verb of the `smthrs` binary; the TUI tests check that
 * each opens its own `smthrs <verb> --help`.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export declare const knowledge: {
    readonly packages: readonly [{
        readonly name: "@smthrs/flow";
        readonly about: "Flow authoring model: Flow.make, Action, durable waits, retry, the runtime port.";
    }, {
        readonly name: "@smthrs/plan";
        readonly about: "Node combinators for flow bodies: Node.succeed, Node.all, Node.bindPlanned, Node.map.";
    }, {
        readonly name: "@smthrs/core";
        readonly about: "Flow metadata: annotations, effects, placement, and Markdown lowering.";
    }, {
        readonly name: "@smthrs/agent";
        readonly about: "Production agent loop (Agent), AgentSession, AgentAction for typed agent steps, CellPlugin.";
    }, {
        readonly name: "@smthrs/harness";
        readonly about: "Cell controller and QuickJS sandbox; FlowBinding pairs a declaration with its handler.";
    }, {
        readonly name: "@smthrs/plugin";
        readonly about: "Typed plugin kernel: Plugin, hooks, ordering, config waterfall.";
    }, {
        readonly name: "@smthrs/registry";
        readonly about: "Flow descriptor discovery and progressive disclosure.";
    }, {
        readonly name: "@smthrs/std";
        readonly about: "Standard flows: read, write, edit, grep, glob, bash, fetch, test.";
    }, {
        readonly name: "@smthrs/model";
        readonly about: "Provider-neutral model requests, seats, streaming events, Evaluator (Jev).";
    }, {
        readonly name: "@smthrs/engine";
        readonly about: "Runtime that executes flows, plus HTTP and RPC transports.";
    }, {
        readonly name: "@smthrs/control";
        readonly about: "Durable control plane: launch, watch, cancel, and RPC projections of runs.";
    }, {
        readonly name: "@smthrs/mcp";
        readonly about: "Projects a remote MCP server's tools as ordinary flow bindings.";
    }, {
        readonly name: "@smthrs/build";
        readonly about: "PACKAGE.ts target graphs; @smthrs/build-cli executes them with caching.";
    }, {
        readonly name: "@smthrs/cli";
        readonly about: "The `smthrs` binary (also `smithers`); run it with `npx smthrs <verb>`.";
    }];
    readonly cli: readonly [{
        readonly name: "smthrs flow list";
        readonly about: "List project flows.";
    }, {
        readonly name: "smthrs flow show <flow>";
        readonly about: "Show a flow's identity and description.";
    }, {
        readonly name: "smthrs flow plan <flow>";
        readonly about: "Compile a plan and its approval payload without executing.";
    }, {
        readonly name: "smthrs flow start <flow>";
        readonly about: "Plan, approve, and start a flow; --data '<json>' input, --detached to return once admitted.";
    }, {
        readonly name: "smthrs runs list";
        readonly about: "List durable runs by flow or status.";
    }, {
        readonly name: "smthrs runs show <run>";
        readonly about: "A run's status and diagnosis.";
    }, {
        readonly name: "smthrs runs logs <run>";
        readonly about: "Read or follow a run's events.";
    }, {
        readonly name: "smthrs runs output <run>";
        readonly about: "Recorded outputs for one node or all nodes.";
    }, {
        readonly name: "smthrs runs cancel <run>";
        readonly about: "Cancel one durable run.";
    }, {
        readonly name: "smthrs runs resume <run>";
        readonly about: "Resume a parked run.";
    }, {
        readonly name: "smthrs approvals";
        readonly about: "Find and resolve pending approval requests.";
    }, {
        readonly name: "smthrs generate flow <name>";
        readonly about: "Scaffold a Markdown flow without replacing an existing one.";
    }, {
        readonly name: "smthrs test <pattern>";
        readonly about: "Run PACKAGE.ts test targets, e.g. //packages/smithers/agent:test.";
    }, {
        readonly name: "smthrs docs <pattern>";
        readonly about: "Docs parity targets, e.g. smthrs docs //packages/smithers/agent:docs.";
    }, {
        readonly name: "smthrs tui";
        readonly about: "Open the terminal coding agent.";
    }];
    readonly authoring: readonly [{
        readonly name: "File flow";
        readonly about: ".smithers/flows/<name>/flow.ts default-exports Flow.make(\"<name>\", { description, capabilities, effects, payload, success, error?, body }) from @smthrs/flow. The tag is required and matches the path.";
    }, {
        readonly name: "Body";
        readonly about: "body returns a Node from @smthrs/plan: Node.succeed(value), Action.call(...), Node.all({...}), Node.bindPlanned(node, next). Never a second graph model.";
    }, {
        readonly name: "Effects";
        readonly about: "effects: { reads, writes, mode: \"expected\", onConflict: \"serialize\", tier: \"sealed\" | \"irreversible\" }. capabilities are literals such as fs:read:** or proc:spawn:*.";
    }, {
        readonly name: "Markdown flow";
        readonly about: ".smithers/flows/<name>/flow.mdx: frontmatter declares description and capabilities; the prompt is the body.";
    }, {
        readonly name: "Agent step";
        readonly about: "AgentAction.make from @smthrs/agent runs a typed model step inside a flow.";
    }, {
        readonly name: "Run";
        readonly about: "npx smthrs flow start <name> --data '{...}' --detached, then smthrs runs show <run>.";
    }, {
        readonly name: "Checks";
        readonly about: "pnpm --filter <package> test and typecheck; after docs edits pnpm docs:sync then pnpm docs:check.";
    }];
};
/**
 * The topics `smithers.guide` answers.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export declare const Topic: Schema.Literals<readonly ["packages", "cli", "authoring", "all"]>;
/**
 * The decoded form of {@link Topic}.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Topic = typeof Topic.Type;
/**
 * The always-present system teaching. Short on purpose: details come from
 * `smithers.guide`.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export declare const brief: string;
/**
 * Host operations behind the run flows. Each returns JSON-shaped data or a
 * promise of it; host exceptions become opaque call failures.
 *
 * The model chooses every `id` and `flow` these receive, and this plugin
 * passes them through unchanged, so the host is the authority: `inspect`
 * answers only runs this session may read, and `run` refuses flows that are
 * not model-invocable and launches through the host's own approval.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Ports {
    /** Discovered project flows a model may start. */
    readonly list: () => unknown;
    /** Requests a background run and returns its receipt without waiting. */
    readonly run: (request: {
        readonly id: string;
        readonly flow: string;
        readonly input?: {
            readonly [key: string]: Schema.Json;
        } | undefined;
    }) => unknown;
    /** Reads one run's status, recent steps, and result. Does not wait. */
    readonly inspect: (id: string) => unknown;
}
/**
 * The `smithers.guide` flow: bounded, structured facts by topic.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export declare const guide: FlowBinding.Binding;
/**
 * The executable flows the plugin contributes for `ports`.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export declare const flows: (ports?: Ports | undefined) => ReadonlyArray<FlowBinding.Binding>;
/**
 * The Smithers plugin. Pass it in `Agent.Options.plugins`.
 *
 * Without `ports` it teaches and serves `smithers.guide` only. A contributed
 * name that is already in the catalog fails catalog assembly; nothing is
 * shadowed.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export declare const make: (ports?: Ports | undefined) => FlowsPlugin<FlowsHooks>;
