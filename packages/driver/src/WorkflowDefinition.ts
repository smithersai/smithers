import type { JSX } from "smithers/jsx-runtime";
import type { SmithersCtx } from "./SmithersCtx.ts";
import type { SmithersWorkflowOptions } from "@smithers/scheduler/SmithersWorkflowOptions";
import type { SchemaRegistryEntry } from "@smithers/db/SchemaRegistryEntry";

export type WorkflowDefinition<Schema = unknown> = {
  db?: unknown;
  build: (ctx: SmithersCtx<Schema>) => JSX.Element;
  opts: SmithersWorkflowOptions;
  schemaRegistry?: Map<string, SchemaRegistryEntry>;
  zodToKeyName?: Map<import("zod").ZodObject<any>, string>;
};
