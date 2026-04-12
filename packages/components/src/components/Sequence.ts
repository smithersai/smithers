import React from "react";
export type SequenceProps = {
    skipIf?: boolean;
    children?: React.ReactNode;
};
export declare function Sequence(props: SequenceProps): React.DOMElement<SequenceProps, Element> | null;
