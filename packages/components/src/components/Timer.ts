import React from "react";
export type TimerProps = {
    id: string;
    /**
     * Relative duration (examples: "500ms", "1s", "30m", "1h", "7d").
     */
    duration?: string;
    /**
     * Absolute fire time (ISO timestamp or Date).
     */
    until?: string | Date;
    /**
     * Recurring timer syntax is reserved for phase 2 and is not supported yet.
     */
    every?: string;
    skipIf?: boolean;
    dependsOn?: string[];
    needs?: Record<string, string>;
    label?: string;
    meta?: Record<string, unknown>;
    key?: string;
};
export declare function Timer(props: TimerProps): React.ReactElement<{
    id: string;
    key: string | undefined;
    duration: string | undefined;
    until: string | undefined;
    dependsOn: string[] | undefined;
    needs: Record<string, string> | undefined;
    label: string;
    meta: {
        until?: string | undefined;
        duration?: string | undefined;
        timer: boolean;
    } | undefined;
    __smithersTimerDuration: string | undefined;
    __smithersTimerUntil: string | undefined;
}, string | React.JSXElementConstructor<any>> | null;
