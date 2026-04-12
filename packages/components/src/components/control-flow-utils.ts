import React from "react";
/**
 * Failure-boundary components need inner tasks to fail "softly" so the
 * scheduler can decide whether to run catch/finally or compensations.
 */
export declare function forceContinueOnFail(node: React.ReactNode): React.ReactNode;
