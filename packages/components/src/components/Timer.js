import React from "react";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/** @typedef {import("./TimerProps.ts").TimerProps} TimerProps */

/**
 * @param {TimerProps} props
 */
export function Timer(props) {
    if (props.skipIf)
        return null;
    const hasDuration = typeof props.duration === "string" && props.duration.trim().length > 0;
    const hasUntil = props.until !== undefined && props.until !== null && String(props.until).trim().length > 0;
    if ((hasDuration ? 1 : 0) + (hasUntil ? 1 : 0) !== 1) {
        throw new SmithersError("INVALID_INPUT", `<Timer id="${props.id}"> requires exactly one of "duration" or "until".`);
    }
    if (props.every !== undefined) {
        throw new SmithersError("INVALID_INPUT", `<Timer id="${props.id}"> does not support "every" yet. Recurring timers ship in phase 2.`);
    }
    const untilIso = props.until instanceof Date
        ? props.until.toISOString()
        : typeof props.until === "string"
            ? props.until
            : undefined;
    const timerMeta = {
        timer: true,
        ...(hasDuration ? { duration: props.duration } : {}),
        ...(hasUntil ? { until: untilIso } : {}),
        ...props.meta,
    };
    return React.createElement("smithers:timer", {
        id: props.id,
        key: props.key,
        duration: props.duration,
        until: untilIso,
        dependsOn: props.dependsOn,
        needs: props.needs,
        label: props.label ?? `timer:${props.id}`,
        meta: Object.keys(timerMeta).length > 0 ? timerMeta : undefined,
        __smithersTimerDuration: props.duration,
        __smithersTimerUntil: untilIso,
    });
}
