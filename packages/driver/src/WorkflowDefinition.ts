import type { SmithersCtx } from "./SmithersCtx.ts";

export type WorkflowDefinition<Schema, Element> = {
  db?: unknown;
  build: (ctx: SmithersCtx<Schema>) => Element;
  opts?: unknown;
  schemaRegistry?: unknown;
  zodToKeyName?: Map<any, string>;
};
