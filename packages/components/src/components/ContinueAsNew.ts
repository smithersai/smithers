import React from "react";
export type ContinueAsNewProps = {
    /**
     * Optional JSON-serializable state carried into the new run.
     */
    state?: unknown;
};
export declare function ContinueAsNew(props: ContinueAsNewProps): React.ReactElement<{
    stateJson: string | undefined;
}, string | React.JSXElementConstructor<any>>;
/**
 * Convenience helper for conditional continuation inside workflow JSX:
 * `{shouldContinue ? continueAsNew({ cursor }) : null}`
 */
export declare function continueAsNew(state?: unknown): React.FunctionComponentElement<ContinueAsNewProps>;
