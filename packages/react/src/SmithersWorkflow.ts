import type React from "react";
import type { SmithersCtx } from "@smithers/driver/SmithersCtx";
import type { SmithersWorkflowOptions } from "@smithers/scheduler/SmithersWorkflowOptions";
import type { SchemaRegistryEntry } from "@smithers/db/SchemaRegistryEntry";

export type SmithersWorkflow<Schema> = {
  db: unknown;
  build: (ctx: SmithersCtx<Schema>) => React.ReactElement;
  opts: SmithersWorkflowOptions;
  schemaRegistry?: Map<string, SchemaRegistryEntry>;
  /** Reverse lookup: ZodObject reference → schema key name */
  zodToKeyName?: Map<import("zod").ZodObject<any>, string>;
};
