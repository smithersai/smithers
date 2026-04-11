import React from "react";
import type { SmithersCtx } from "@smithers/driver/SmithersCtx";
import { SmithersError } from "@smithers/errors/SmithersError";

export * from "@smithers/driver/buildContext";
export type { SmithersCtx } from "@smithers/driver/SmithersCtx";
export type { OutputSnapshot } from "@smithers/driver/OutputSnapshot";
export type { BuildContextOptions } from "@smithers/driver/BuildContextOptions";

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
