import type { z } from "zod";
import type { SchemaRegistryEntry } from "@smithers/db/SchemaRegistryEntry";
import type { SmithersCtx } from "./SmithersCtx";
import type { SmithersWorkflowOptions } from "@smithers/scheduler/SmithersWorkflowOptions";

export type Workflow<Schema = unknown, Element = unknown> = {
  db?: unknown;
  build: (ctx: SmithersCtx<Schema>) => Element;
  opts: SmithersWorkflowOptions;
  schemaRegistry?: Map<string, SchemaRegistryEntry>;
  zodToKeyName?: Map<z.ZodObject<any>, string>;
};
