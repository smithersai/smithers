// @smithers-type-exports-begin
/**
 * @template D
 * @typedef {import("./Task.ts").InferDeps<D>} InferDeps
 */
/** @typedef {import("./Task.ts").OutputTarget} OutputTarget */
// @smithers-type-exports-end

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { markdownComponents } from "../markdownComponents.js";
import { zodSchemaToJsonExample } from "../zod-to-example.js";
import { SmithersError } from "@smithers/errors/SmithersError";
import { SmithersContext } from "@smithers/react-reconciler/context";
import { AspectContext } from "../aspects/AspectContext.js";
import { ClaudeCodeAgent } from "@smithers/agents/ClaudeCodeAgent";
import { GeminiAgent } from "@smithers/agents/GeminiAgent";
import { PiAgent } from "@smithers/agents/PiAgent";
/** @typedef {import("@smithers/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./Task.ts").DepsSpec} DepsSpec */
/** @typedef {import("./Task.ts").TaskProps} TaskProps */

/**
 * Render a prompt React node to plain markdown text.
 *
 * If the prompt is a React element (e.g. a compiled MDX component), we inject
 * `markdownComponents` via the standard MDX `components` prop so that
 * renderToStaticMarkup outputs clean markdown instead of HTML.
 * No HTML tag stripping or entity decoding needed.
 */
export function renderPromptToText(prompt) {
    if (prompt == null)
        return "";
    if (typeof prompt === "string")
        return prompt;
    if (typeof prompt === "number")
        return String(prompt);
    try {
        let element;
        if (React.isValidElement(prompt)) {
            // Inject markdown components into the element so MDX components
            // render fragments instead of HTML tags.
            element = React.cloneElement(prompt, {
                components: markdownComponents,
            });
        }
        else {
            element = React.createElement(React.Fragment, null, prompt);
        }
        return renderToStaticMarkup(element)
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }
    catch (err) {
        const result = String(prompt ?? "");
        if (result === "[object Object]") {
            throw new SmithersError("MDX_PRELOAD_INACTIVE", `MDX prompt could not be rendered — the prompt resolved to [object Object] instead of a React component.\n\n` +
                `This usually means the MDX preload is not active. Common causes:\n` +
                `  • bunfig.toml uses [run] preload instead of top-level preload (the [run] section doesn't apply to dynamic imports)\n` +
                `  • bunfig.toml is not in the current working directory\n` +
                `  • mdxPlugin() is not registered in the preload script\n` +
                `  • The MDX file is imported without a default import (use: import MyPrompt from "./prompt.mdx")\n\n` +
                `Original error: ${err instanceof Error ? err.message : String(err)}`);
        }
        return result;
    }
}
/**
 * @param {any} value
 * @returns {value is import("zod").ZodObject<any>}
 */
function isZodObject(value) {
    return Boolean(value && typeof value === "object" && "shape" in value);
}
/**
 * @param {DepsSpec | undefined} deps
 * @param {Record<string, string> | undefined} needs
 * @returns {string[] | undefined}
 */
function deriveDepNodeIds(deps, needs) {
    if (!deps)
        return undefined;
    const ids = new Set();
    for (const key of Object.keys(deps)) {
        const nodeId = needs?.[key] ?? key;
        if (nodeId)
            ids.add(nodeId);
    }
    return ids.size > 0 ? [...ids] : undefined;
}
/**
 * @param {string[] | undefined} dependsOn
 * @param {string[] | undefined} depNodeIds
 * @returns {string[] | undefined}
 */
function mergeDependsOn(dependsOn, depNodeIds) {
    const merged = new Set();
    for (const id of dependsOn ?? [])
        merged.add(id);
    for (const id of depNodeIds ?? [])
        merged.add(id);
    return merged.size > 0 ? [...merged] : undefined;
}
/**
 * @param {any} ctx
 * @param {DepsSpec | undefined} deps
 * @param {Record<string, string> | undefined} needs
 * @param {string} [taskId]
 * @returns {Record<string, unknown> | null}
 */
function resolveDeps(ctx, deps, needs, taskId) {
    if (!deps)
        return Object.create(null);
    const keys = Object.keys(deps);
    if (keys.length === 0)
        return Object.create(null);
    const resolved = Object.create(null);
    for (const key of keys) {
        const target = deps[key];
        const nodeId = needs?.[key] ?? key;
        const value = ctx.outputMaybe(target, { nodeId });
        if (value === undefined)
            return null;
        resolved[key] = value;
    }
    return resolved;
}
/**
 * Validate that all deps are satisfied. Throws a descriptive SmithersError
 * naming which dep is missing and which task needs it.
 */
function validateDeps(ctx, deps, needs, taskId) {
    for (const key of Object.keys(deps)) {
        const target = deps[key];
        const nodeId = needs?.[key] ?? key;
        const value = ctx.outputMaybe(target, { nodeId });
        if (value === undefined) {
            throw new SmithersError("DEP_NOT_SATISFIED", `Task "${taskId}" dependency "${key}" (resolved from node "${nodeId}") is not satisfied. ` +
                `The upstream task must complete and produce output before this task can run.`, { taskId, depKey: key, resolvedNodeId: nodeId });
        }
    }
}
/**
 * @param {AgentLike} agent
 * @param {string[] | undefined} allowTools
 * @returns {AgentLike}
 */
function applyCliToolAllowlist(agent, allowTools) {
    if (!allowTools) {
        return agent;
    }
    if (agent instanceof ClaudeCodeAgent) {
        const opts = { ...agent.opts };
        if (allowTools.length === 0) {
            return new ClaudeCodeAgent({
                ...opts,
                allowedTools: [],
                tools: "",
            });
        }
        return new ClaudeCodeAgent({
            ...opts,
            allowedTools: [...allowTools],
        });
    }
    if (agent instanceof PiAgent) {
        const opts = { ...agent.opts };
        if (allowTools.length === 0) {
            return new PiAgent({
                ...opts,
                tools: [],
                noTools: true,
            });
        }
        return new PiAgent({
            ...opts,
            tools: [...allowTools],
            noTools: false,
        });
    }
    if (agent instanceof GeminiAgent) {
        const opts = { ...agent.opts };
        return new GeminiAgent({
            ...opts,
            allowedTools: [...allowTools],
        });
    }
    return agent;
}
/**
 * @param {unknown} ctx
 * @param {string[] | undefined} allowTools
 * @returns {string[] | undefined}
 */
function resolveCliToolAllowlist(ctx, allowTools) {
    if (allowTools !== undefined) {
        return allowTools;
    }
    const cliAgentToolsDefault = ctx && typeof ctx === "object"
        ? ctx.__smithersRuntime?.cliAgentToolsDefault
        : undefined;
    return cliAgentToolsDefault === "explicit-only" ? [] : undefined;
}
/**
 * @template Row, Output, D
 * @param {TaskProps<Row, Output, D>} props
 */
export function Task(props) {
    const { children, agent, fallbackAgent, deps, ...rest } = props;
    const taskContext = props.smithersContext ?? SmithersContext;
    const ctx = React.useContext(taskContext);
    const aspectCtx = React.useContext(AspectContext);
    const depNodeIds = deriveDepNodeIds(deps, rest.needs);
    if (deps && !ctx) {
        throw new SmithersError("CONTEXT_OUTSIDE_WORKFLOW", "Task deps require a workflow context. Build the workflow with createSmithers().");
    }
    const resolvedDeps = deps ? resolveDeps(ctx, deps, rest.needs, rest.id) : undefined;
    if (deps && resolvedDeps == null) {
        // Deps not yet available — component defers until upstream tasks complete.
        // This is normal reactive behavior; the task will re-render once deps are ready.
        return null;
    }
    // Build aspect metadata to attach to the task element so the engine can
    // enforce budgets and tracking at execution time.
    const aspectMeta = aspectCtx ? buildAspectMeta(aspectCtx) : undefined;
    const agentChain = Array.isArray(agent)
        ? fallbackAgent
            ? [...agent, fallbackAgent]
            : agent
        : agent && fallbackAgent
            ? [agent, fallbackAgent]
            : agent;
    const effectiveAllowTools = resolveCliToolAllowlist(ctx, rest.allowTools);
    const restrictedAgentChain = Array.isArray(agentChain)
        ? agentChain.map((entry) => applyCliToolAllowlist(entry, effectiveAllowTools))
        : agentChain
            ? applyCliToolAllowlist(agentChain, effectiveAllowTools)
            : agentChain;
    const nextDependsOn = mergeDependsOn(rest.dependsOn, depNodeIds);
    const childValue = typeof children === "function" && (agent || deps)
        ? children(resolvedDeps ?? Object.create(null))
        : children;
    if (agent) {
        // Auto-inject `schema` prop into React element children when output is a ZodObject
        let childElement = childValue;
        const schemaForInjection = props.outputSchema ??
            (isZodObject(props.output) ? props.output : undefined);
        if (React.isValidElement(childValue) && schemaForInjection) {
            childElement = React.cloneElement(childValue, {
                schema: zodSchemaToJsonExample(schemaForInjection),
            });
        }
        const prompt = renderPromptToText(childElement);
        return React.createElement("smithers:task", {
            ...rest,
            dependsOn: nextDependsOn,
            waitAsync: rest.async === true,
            agent: restrictedAgentChain,
            __smithersKind: "agent",
            ...aspectMeta,
        }, prompt);
    }
    if (typeof children === "function" && !deps) {
        const nextProps = {
            ...rest,
            dependsOn: nextDependsOn,
            waitAsync: rest.async === true,
            __smithersKind: "compute",
            __smithersComputeFn: children,
            ...aspectMeta,
        };
        return React.createElement("smithers:task", nextProps, null);
    }
    const nextProps = {
        ...rest,
        dependsOn: nextDependsOn,
        waitAsync: rest.async === true,
        __smithersKind: "static",
        __smithersPayload: childValue,
        __payload: childValue,
        ...aspectMeta,
    };
    return React.createElement("smithers:task", nextProps, null);
}
/**
 * Build the __aspects metadata object from the current AspectContext.
 * This is attached to the smithers:task element props so the engine
 * can read budgets and tracking config at execution time.
 */
function buildAspectMeta(aspectCtx) {
    return {
        __aspects: {
            tokenBudget: aspectCtx.tokenBudget,
            latencySlo: aspectCtx.latencySlo,
            costBudget: aspectCtx.costBudget,
            tracking: aspectCtx.tracking,
            accumulator: aspectCtx.accumulator,
        },
    };
}
