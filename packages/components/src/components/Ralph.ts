import React from "react";
export type LoopProps = {
    id?: string;
    until?: boolean;
    maxIterations?: number;
    onMaxReached?: "fail" | "return-last";
    continueAsNewEvery?: number;
    skipIf?: boolean;
    children?: React.ReactNode;
};
export declare function Loop(props: LoopProps): React.DOMElement<LoopProps, Element> | null;
/** @deprecated Use `Loop` instead. */
export type RalphProps = LoopProps;
/** @deprecated Use `Loop` instead. */
export declare const Ralph: typeof Loop;
