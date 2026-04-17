import type { SmithersWorkflowOptions } from "@smithers/scheduler/SmithersWorkflowOptions";
import type { SchemaRegistryEntry } from "@smithers/db/SchemaRegistryEntry";
import type { WorkflowElement } from "./WorkflowElement.ts";

type WorkflowSmithersCtx<Schema = unknown> = import("./SmithersCtx.js").SmithersCtx<Schema>;

export type WorkflowDefinition<Schema = unknown> = {
  readableName?: string;
  description?: string;
  db?: unknown;
  build: (ctx: WorkflowSmithersCtx<Schema>) => WorkflowElement;
  opts: SmithersWorkflowOptions;
  schemaRegistry?: Map<string, SchemaRegistryEntry>;
  zodToKeyName?: Map<import("zod").ZodObject<any>, string>;
};
