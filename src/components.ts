import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { markdownComponents } from "./mdx-components";
import { zodSchemaToJsonExample } from "./zod-to-example";
import { DEFAULT_MERGE_QUEUE_CONCURRENCY, WORKTREE_EMPTY_PATH_ERROR } from "./constants";
import type {
  WorkflowProps,
  TaskProps,
  SequenceProps,
  ParallelProps,
  MergeQueueProps,
  BranchProps,
  RalphProps,
  WorktreeProps,
} from "./types";
export function Workflow(props: WorkflowProps) {
  return React.createElement("smithers:workflow", props, props.children);
}

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

export function Task<Row>(props: TaskProps<Row>) {
  const { children, agent, ...rest } = props as any;
  if (agent) {
    // Auto-inject `schema` prop into React element children when output is a ZodObject
    let childElement = children;
    const outputIsZod = props.output && typeof props.output !== "string";
    if (React.isValidElement(children) && outputIsZod) {
      childElement = React.cloneElement(children as React.ReactElement<any>, {
        schema: zodSchemaToJsonExample(props.output as any),
      });
    }
    const prompt = renderChildrenToText(childElement);
    return React.createElement(
      "smithers:task",
      { ...rest, agent, __smithersKind: "agent" },
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

export function Sequence(props: SequenceProps) {
  if (props.skipIf) return null;
  return React.createElement("smithers:sequence", props, props.children);
}

export function Parallel(props: ParallelProps) {
  if (props.skipIf) return null;
  // Align prop sanitization with other structural components
  const next: { maxConcurrency?: number; id?: string } = {
    maxConcurrency: props.maxConcurrency,
    id: props.id,
  };
  return React.createElement("smithers:parallel", next, props.children);
}

export function MergeQueue(props: MergeQueueProps) {
  if (props.skipIf) return null;
  const next: { maxConcurrency: number; id?: string } = {
    maxConcurrency: props.maxConcurrency ?? DEFAULT_MERGE_QUEUE_CONCURRENCY,
    id: props.id,
  };
  return React.createElement("smithers:merge-queue", next, props.children);
}

export function Branch(props: BranchProps) {
  if (props.skipIf) return null;
  const chosen = props.if ? props.then : (props.else ?? null);
  return React.createElement("smithers:branch", props, chosen);
}

export function Ralph(props: RalphProps) {
  if (props.skipIf) return null;
  return React.createElement("smithers:ralph", props, props.children);
}

export function Worktree(props: WorktreeProps) {
  if (typeof props.path !== "string" || props.path.trim() === "") {
    throw new Error(WORKTREE_EMPTY_PATH_ERROR);
  }
  if (props.skipIf) return null;
  const next: { id?: string; path: string } = { id: props.id, path: props.path };
  return React.createElement("smithers:worktree", next, props.children);
}
