import React from "react";
export type BranchProps = {
    if: boolean;
    then: React.ReactElement;
    else?: React.ReactElement | null;
    skipIf?: boolean;
};
export declare function Branch(props: BranchProps): React.ReactElement<BranchProps, string | React.JSXElementConstructor<any>> | null;
