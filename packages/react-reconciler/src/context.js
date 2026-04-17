// @smithers-type-exports-begin
/** @typedef {import("./OutputSnapshot.ts").OutputSnapshot} OutputSnapshot */
/** @typedef {import("./SmithersCtxOptions.ts").SmithersCtxOptions} SmithersCtxOptions */
// @smithers-type-exports-end

import React from "react";
import { SmithersCtx } from "@smithers/driver/SmithersCtx";
import { SmithersError } from "@smithers/errors/SmithersError";
export { SmithersCtx } from "@smithers/driver/SmithersCtx";
/** @type {React.Context<SmithersCtx<any> | null>} */
export const SmithersContext = React.createContext(null);
SmithersContext.displayName = "SmithersContext";
/**
 * @template Schema
 * @returns {{ SmithersContext: React.Context<SmithersCtx<Schema> | null>, useCtx: () => SmithersCtx<Schema> }}
 */
export function createSmithersContext() {
    /** @type {React.Context<SmithersCtx<Schema> | null>} */
    const Context = React.createContext(null);
    Context.displayName = "SmithersContext";
    /**
   * @returns {SmithersCtx<Schema>}
   */
    function useCtx() {
        const ctx = React.useContext(Context);
        if (!ctx) {
            throw new SmithersError("CONTEXT_OUTSIDE_WORKFLOW", "useCtx() must be called inside a <Workflow> created by createSmithers()");
        }
        return ctx;
    }
    return { SmithersContext: Context, useCtx };
}
