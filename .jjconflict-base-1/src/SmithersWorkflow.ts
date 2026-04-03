import type React from "react";
import type { SmithersCtx } from "./SmithersCtx";
import type { SmithersWorkflowOptions } from "./SmithersWorkflowOptions";
import type { SchemaRegistryEntry } from "./SchemaRegistryEntry";

export type SmithersWorkflow<Schema> = {
  db: unknown;
  build: (ctx: SmithersCtx<Schema>) => React.ReactElement;
  opts: SmithersWorkflowOptions;
  schemaRegistry?: Map<string, SchemaRegistryEntry>;
  /** Reverse lookup: ZodObject reference → schema key name */
  zodToKeyName?: Map<import("zod").ZodObject<any>, string>;
};
