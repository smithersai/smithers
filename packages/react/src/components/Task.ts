import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { markdownComponents } from "../markdownComponents";
import { zodSchemaToJsonExample } from "../zod-to-example";
import type { AgentLike } from "@smithers/core/AgentLike";
import { SmithersError } from "@smithers/errors/SmithersError";
import type { CachePolicy } from "@smithers/scheduler/CachePolicy";
import type { RetryPolicy } from "@smithers/scheduler/RetryPolicy";
import type { ScorersMap } from "@smithers/scorers/types";
import type { TaskMemoryConfig } from "@smithers/memory/types";
import { SmithersContext } from "../context";
import type { InferOutputEntry } from "@smithers/driver/OutputAccessor";
import { AspectContext, type AspectContextValue } from "../aspects/AspectContext";
import { ClaudeCodeAgent } from "@smithers/agents/ClaudeCodeAgent";
import { GeminiAgent } from "@smithers/agents/GeminiAgent";
import { PiAgent } from "@smithers/agents/PiAgent";

/**
 * Valid output targets: a Zod schema (recommended with createSmithers),
 * a Drizzle table object, or a string key (escape hatch).
 */
export type OutputTarget = import("zod").ZodObject<any> | { $inferSelect: any } | string;

export type DepsSpec = Record<string, OutputTarget>;

type InferDepValue<T> = T extends string ? unknown : InferOutputEntry<T>;

export type InferDeps<D extends DepsSpec> = {
  [K in keyof D]: InferDepValue<D[K]>;
};

export type TaskProps<
  Row,
  Output extends OutputTarget = OutputTarget,
  D extends DepsSpec = {},
> = {
  key?: string;
  id: string;
  /** Where to store the task's result. Pass a Zod schema from `outputs` (recommended), a Drizzle table, or a string key. */
  output: Output;
  /**
   * Optional Zod schema describing the expected agent output shape.
   * When `output` is already a ZodObject this is inferred automatically.
   * Used for validation and to inject schema examples into MDX prompts.
   */
  outputSchema?: import("zod").ZodObject<any>;
  /** Agent or array of agents [primary, fallback1, fallback2, ...]. Tries in order on retries. */
  agent?: AgentLike | AgentLike[];
  /** Convenience alias for a single retry fallback without exposing array syntax in JSX. */
  fallbackAgent?: AgentLike;
  /** Explicit dependency on other task node IDs. The task will not run until all listed tasks complete. */
  dependsOn?: string[];
  /** Named dependencies on other tasks. Keys become context keys, values are task node IDs. */
  needs?: Record<string, string>;
  /** Render-time typed dependencies. Keys resolve from task ids of the same name, or from matching `needs` entries. */
  deps?: D;
  skipIf?: boolean;
  needsApproval?: boolean;
  /** When paired with `needsApproval`, do not block unrelated downstream flow while the approval is pending. */
  async?: boolean;
  timeoutMs?: number;
  heartbeatTimeoutMs?: number;
  heartbeatTimeout?: number;
  /** Disable retries entirely. Equivalent to retries={0}. */
  noRetry?: boolean;
  retries?: number;
  retryPolicy?: RetryPolicy;
  continueOnFail?: boolean;
  cache?: CachePolicy;
  /** Optional scorers to evaluate this task's output after completion. */
  scorers?: ScorersMap;
  /** Optional cross-run memory configuration. */
  memory?: TaskMemoryConfig;
  allowTools?: string[];
  label?: string;
  meta?: Record<string, unknown>;
  /** @internal Used by createSmithers() to bind tasks to the correct workflow context. */
  smithersContext?: React.Context<any>;
  children?:
    | string
    | Row
    | (() => Row | Promise<Row>)
    | React.ReactNode
    | ((deps: InferDeps<D>) => Row | React.ReactNode);
};

/**
 * Render a prompt React node to plain markdown text.
 *
 * If the prompt is a React element (e.g. a compiled MDX component), we inject
 * `markdownComponents` via the standard MDX `components` prop so that
 * renderToStaticMarkup outputs clean markdown instead of HTML.
 * No HTML tag stripping or entity decoding needed.
 */
export function renderPromptToText(prompt: any): string {
  if (prompt == null) return "";
  if (typeof prompt === "string") return prompt;
  if (typeof prompt === "number") return String(prompt);
  try {
    let element: React.ReactElement;
    if (React.isValidElement(prompt)) {
      // Inject markdown components into the element so MDX components
      // render fragments instead of HTML tags.
      element = React.cloneElement(prompt as React.ReactElement<any>, {
        components: markdownComponents,
      });
    } else {
      element = React.createElement(React.Fragment, null, prompt);
    }
    return renderToStaticMarkup(element)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch (err) {
    const result = String(prompt ?? "");
    if (result === "[object Object]") {
      throw new SmithersError(
        "MDX_PRELOAD_INACTIVE",
        `MDX prompt could not be rendered — the prompt resolved to [object Object] instead of a React component.\n\n` +
          `This usually means the MDX preload is not active. Common causes:\n` +
          `  • bunfig.toml uses [run] preload instead of top-level preload (the [run] section doesn't apply to dynamic imports)\n` +
          `  • bunfig.toml is not in the current working directory\n` +
          `  • mdxPlugin() is not registered in the preload script\n` +
          `  • The MDX file is imported without a default import (use: import MyPrompt from "./prompt.mdx")\n\n` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return result;
  }
}

function isZodObject(value: any): value is import("zod").ZodObject<any> {
  return Boolean(value && typeof value === "object" && "shape" in value);
}

function deriveDepNodeIds(
  deps: DepsSpec | undefined,
  needs: Record<string, string> | undefined,
): string[] | undefined {
  if (!deps) return undefined;
  const ids = new Set<string>();
  for (const key of Object.keys(deps)) {
    const nodeId = needs?.[key] ?? key;
    if (nodeId) ids.add(nodeId);
  }
  return ids.size > 0 ? [...ids] : undefined;
}

function mergeDependsOn(
  dependsOn: string[] | undefined,
  depNodeIds: string[] | undefined,
): string[] | undefined {
  const merged = new Set<string>();
  for (const id of dependsOn ?? []) merged.add(id);
  for (const id of depNodeIds ?? []) merged.add(id);
  return merged.size > 0 ? [...merged] : undefined;
}

function resolveDeps(
  ctx: any,
  deps: DepsSpec | undefined,
  needs: Record<string, string> | undefined,
  taskId?: string,
): Record<string, unknown> | null {
  if (!deps) return Object.create(null);
  const keys = Object.keys(deps);
  if (keys.length === 0) return Object.create(null);

  const resolved: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const target = deps[key];
    const nodeId = needs?.[key] ?? key;
    const value = ctx.outputMaybe(target as any, { nodeId });
    if (value === undefined) return null;
    resolved[key] = value;
  }
  return resolved;
}

/**
 * Validate that all deps are satisfied. Throws a descriptive SmithersError
 * naming which dep is missing and which task needs it.
 */
function validateDeps(
  ctx: any,
  deps: DepsSpec,
  needs: Record<string, string> | undefined,
  taskId: string,
): void {
  for (const key of Object.keys(deps)) {
    const target = deps[key];
    const nodeId = needs?.[key] ?? key;
    const value = ctx.outputMaybe(target as any, { nodeId });
    if (value === undefined) {
      throw new SmithersError(
        "DEP_NOT_SATISFIED",
        `Task "${taskId}" dependency "${key}" (resolved from node "${nodeId}") is not satisfied. ` +
          `The upstream task must complete and produce output before this task can run.`,
        { taskId, depKey: key, resolvedNodeId: nodeId },
      );
    }
  }
}

function applyCliToolAllowlist(
  agent: AgentLike,
  allowTools: string[] | undefined,
): AgentLike {
  if (!allowTools) {
    return agent;
  }

  if (agent instanceof ClaudeCodeAgent) {
    const opts = { ...(agent as any).opts };
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
    const opts = { ...(agent as any).opts };
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
    const opts = { ...(agent as any).opts };
    return new GeminiAgent({
      ...opts,
      allowedTools: [...allowTools],
    });
  }

  return agent;
}

function resolveCliToolAllowlist(
  ctx: unknown,
  allowTools: string[] | undefined,
): string[] | undefined {
  if (allowTools !== undefined) {
    return allowTools;
  }
  const cliAgentToolsDefault =
    ctx && typeof ctx === "object"
      ? (ctx as any).__smithersRuntime?.cliAgentToolsDefault
      : undefined;
  return cliAgentToolsDefault === "explicit-only" ? [] : undefined;
}

export function Task<Row, Output extends OutputTarget = OutputTarget, D extends DepsSpec = {}>(
  props: TaskProps<Row, Output, D>,
) {
  const { children, agent, fallbackAgent, deps, ...rest } = props as any;
  const taskContext = (props as any).smithersContext ?? SmithersContext;
  const ctx = React.useContext(taskContext);
  const aspectCtx = React.useContext(AspectContext);
  const depNodeIds = deriveDepNodeIds(deps, rest.needs);
  if (deps && !ctx) {
    throw new SmithersError(
      "CONTEXT_OUTSIDE_WORKFLOW",
      "Task deps require a workflow context. Build the workflow with createSmithers().",
    );
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
  const childValue =
    typeof children === "function" && (agent || deps)
      ? (children as any)(resolvedDeps ?? Object.create(null))
      : children;
  if (agent) {
    // Auto-inject `schema` prop into React element children when output is a ZodObject
    let childElement = childValue;
    const schemaForInjection =
      (props as any).outputSchema ??
      (isZodObject(props.output) ? props.output : undefined);
    if (React.isValidElement(childValue) && schemaForInjection) {
      childElement = React.cloneElement(childValue as React.ReactElement<any>, {
        schema: zodSchemaToJsonExample(schemaForInjection as any),
      });
    }
    const prompt = renderPromptToText(childElement);
    return React.createElement(
      "smithers:task",
      {
        ...rest,
        dependsOn: nextDependsOn,
        waitAsync: rest.async === true,
        agent: restrictedAgentChain,
        __smithersKind: "agent",
        ...aspectMeta,
      },
      prompt,
    );
  }
  if (typeof children === "function" && !deps) {
    const nextProps = {
      ...rest,
      dependsOn: nextDependsOn,
      waitAsync: rest.async === true,
      __smithersKind: "compute",
      __smithersComputeFn: children,
      ...aspectMeta,
    } as any;
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
  } as any;
  return React.createElement("smithers:task", nextProps, null);
}

/**
 * Build the __aspects metadata object from the current AspectContext.
 * This is attached to the smithers:task element props so the engine
 * can read budgets and tracking config at execution time.
 */
function buildAspectMeta(aspectCtx: AspectContextValue) {
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
