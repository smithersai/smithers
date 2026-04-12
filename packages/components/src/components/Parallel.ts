import React from "react";
export type ParallelProps = {
    id?: string;
    maxConcurrency?: number;
    skipIf?: boolean;
    children?: React.ReactNode;
};
export declare function Parallel(props: ParallelProps): React.ReactElement<{
    maxConcurrency?: number;
    id?: string;
}, string | React.JSXElementConstructor<any>> | null;
