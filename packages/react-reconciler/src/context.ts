import React from "react";
import { SmithersCtx } from "@smithers/driver/SmithersCtx";
import { SmithersError } from "@smithers/errors/SmithersError";

export { SmithersCtx } from "@smithers/driver/SmithersCtx";
export type { SmithersCtxOptions } from "@smithers/driver/SmithersCtx";
export type { OutputSnapshot } from "@smithers/driver/OutputSnapshot";

export const SmithersContext = React.createContext<SmithersCtx<any> | null>(null);
SmithersContext.displayName = "SmithersContext";

export function createSmithersContext<Schema>() {
  const Context = React.createContext<SmithersCtx<Schema> | null>(null);
  Context.displayName = "SmithersContext";

  function useCtx(): SmithersCtx<Schema> {
    const ctx = React.useContext(Context);
    if (!ctx) {
      throw new SmithersError(
        "CONTEXT_OUTSIDE_WORKFLOW",
        "useCtx() must be called inside a <Workflow> created by createSmithers()",
      );
    }
    return ctx;
  }

  return { SmithersContext: Context, useCtx };
}
