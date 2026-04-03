import React from "react";
import type { AgentLike } from "../AgentLike";
import { Sequence } from "./Sequence";
import { Parallel } from "./Parallel";
import { Task } from "./Task";

type OutputTarget = import("zod").ZodObject<any> | { $inferSelect: any } | string;

export type CategoryConfig = {
  agent: AgentLike;
  /** Output schema for this category's route handler. Overrides `routeOutput`. */
  output?: OutputTarget;
  /** Optional prompt for the route handler. Receives the classified item. */
  prompt?: (item: unknown) => string;
};

export type ClassifyAndRouteProps = {
  id?: string;
  /** Items to classify. A single item or an array of items. */
  items: unknown | unknown[];
  /** Record mapping category names to agents or config objects. */
  categories: Record<string, AgentLike | CategoryConfig>;
  /** Agent that classifies items into categories. */
  classifierAgent: AgentLike;
  /** Output schema for the classification task. */
  classifierOutput: OutputTarget;
  /** Default output schema for routed work. Can be overridden per-category. */
  routeOutput: OutputTarget;
  /** Classification result used to drive routing. Typically from ctx.outputMaybe(). */
  classificationResult?: {
    classifications: Array<{
      itemId?: string;
      category: string;
      [key: string]: unknown;
    }>;
  } | null;
  /** Max parallel routes. */
  maxConcurrency?: number;
  skipIf?: boolean;
  children?: React.ReactNode;
};

function isConfig(value: AgentLike | CategoryConfig): value is CategoryConfig {
  return "agent" in value && typeof (value as any).generate !== "function";
}

/**
 * <ClassifyAndRoute> — Classify items then route to category-specific agents.
 *
 * Composes Sequence, Task, and Parallel. First a classifier Task assigns items
 * to categories, then a Parallel block routes each classified item to the
 * appropriate category agent.
 */
export function ClassifyAndRoute(props: ClassifyAndRouteProps) {
  if (props.skipIf) return null;

  const {
    id,
    items,
    categories,
    classifierAgent,
    classifierOutput,
    routeOutput,
    classificationResult,
    maxConcurrency,
    children,
  } = props;

  const prefix = id ?? "classify-and-route";
  const itemList = Array.isArray(items) ? items : [items];
  const categoryNames = Object.keys(categories);

  // Step 1: Classification task
  const classifyTask = React.createElement(Task, {
    key: `${prefix}-classify`,
    id: `${prefix}-classify`,
    output: classifierOutput,
    agent: classifierAgent,
    label: "Classify items",
    children:
      children ??
      `Classify the following items into categories: ${categoryNames.join(", ")}.\n\nItems:\n${JSON.stringify(itemList, null, 2)}`,
  });

  // Step 2: Route each classified item to its category agent
  const classifications = classificationResult?.classifications ?? [];

  const routeElements = classifications.map((c, idx) => {
    const catKey = c.category;
    const catEntry = categories[catKey];
    if (!catEntry) return null;

    const agent = isConfig(catEntry) ? catEntry.agent : catEntry;
    const output = isConfig(catEntry) ? (catEntry.output ?? routeOutput) : routeOutput;
    const prompt = isConfig(catEntry) && catEntry.prompt
      ? catEntry.prompt(c)
      : `Handle item classified as "${catKey}":\n${JSON.stringify(c, null, 2)}`;

    return React.createElement(Task, {
      key: `${prefix}-route-${c.itemId ?? idx}`,
      id: `${prefix}-route-${c.itemId ?? idx}`,
      output,
      agent,
      continueOnFail: true,
      label: `Route: ${catKey}${c.itemId ? ` (${c.itemId})` : ""}`,
      children: prompt,
    });
  }).filter(Boolean);

  const sequenceChildren: React.ReactElement[] = [classifyTask];

  if (routeElements.length > 0) {
    sequenceChildren.push(
      React.createElement(
        Parallel,
        {
          key: `${prefix}-routes`,
          id: `${prefix}-routes`,
          maxConcurrency,
        },
        ...routeElements,
      ),
    );
  }

  return React.createElement(Sequence, null, ...sequenceChildren);
}
