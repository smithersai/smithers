import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { markdownComponents } from "../markdownComponents";
import { zodSchemaToJsonExample } from "../zod-to-example";
import type { AgentLike } from "../AgentLike";
import type { CachePolicy } from "../CachePolicy";
import type { RetryPolicy } from "../RetryPolicy";

/**
 * Valid output targets: a Zod schema (recommended with createSmithers),
 * a Drizzle table object, or a string key (escape hatch).
 */
export type OutputTarget = import("zod").ZodObject<any> | { $inferSelect: any } | string;

export type TaskProps<Row, Output extends OutputTarget = OutputTarget> = {
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
  skipIf?: boolean;
  needsApproval?: boolean;
  timeoutMs?: number;
  retries?: number;
  retryPolicy?: RetryPolicy;
  continueOnFail?: boolean;
  cache?: CachePolicy;
  label?: string;
  meta?: Record<string, unknown>;
  children: string | Row | (() => Row | Promise<Row>) | React.ReactNode;
};

/**
 * Render JSX children to plain markdown text.
 *
 * If children is a React element (e.g. a compiled MDX component), we inject
 * `markdownComponents` via the standard MDX `components` prop so that
 * renderToStaticMarkup outputs clean markdown instead of HTML.
 * No HTML tag stripping or entity decoding needed.
 */
function renderChildrenToText(children: any): string {
  if (children == null) return "";
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  try {
    let element: React.ReactElement;
    if (React.isValidElement(children)) {
      // Inject markdown components into the element so MDX components
      // render fragments instead of HTML tags.
      element = React.cloneElement(children as React.ReactElement<any>, {
        components: markdownComponents,
      });
    } else {
      element = React.createElement(React.Fragment, null, children);
    }
    return renderToStaticMarkup(element)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch (err) {
    const result = String(children ?? "");
    if (result === "[object Object]") {
      throw new Error(
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

export function Task<Row>(props: TaskProps<Row>) {
  const { children, agent, fallbackAgent, ...rest } = props as any;
  const agentChain = Array.isArray(agent)
    ? fallbackAgent
      ? [...agent, fallbackAgent]
      : agent
    : agent && fallbackAgent
      ? [agent, fallbackAgent]
      : agent;
  if (agent) {
    // Auto-inject `schema` prop into React element children when output is a ZodObject
    let childElement = children;
    const schemaForInjection =
      (props as any).outputSchema ??
      (isZodObject(props.output) ? props.output : undefined);
    if (React.isValidElement(children) && schemaForInjection) {
      childElement = React.cloneElement(children as React.ReactElement<any>, {
        schema: zodSchemaToJsonExample(schemaForInjection as any),
      });
    }
    const prompt = renderChildrenToText(childElement);
    return React.createElement(
      "smithers:task",
      { ...rest, agent: agentChain, __smithersKind: "agent" },
      prompt,
    );
  }
  if (typeof children === "function") {
    const nextProps = {
      ...rest,
      __smithersKind: "compute",
      __smithersComputeFn: children,
    } as any;
    return React.createElement("smithers:task", nextProps, null);
  }
  const nextProps = {
    ...rest,
    __smithersKind: "static",
    __smithersPayload: children,
    __payload: children,
  } as any;
  return React.createElement("smithers:task", nextProps, null);
}
