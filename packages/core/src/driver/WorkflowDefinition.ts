import type { SmithersCtx } from "@smithers/core/SmithersCtx";

export type WorkflowDefinition<Schema, Element> = {
  db?: unknown;
  build: (ctx: SmithersCtx<Schema>) => Element;
  opts?: unknown;
  schemaRegistry?: unknown;
  zodToKeyName?: Map<any, string>;
};
