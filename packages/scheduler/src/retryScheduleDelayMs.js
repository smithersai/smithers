import { Effect, Schedule, ScheduleDecision, ScheduleIntervals } from "effect";
/**
 * @param {Schedule.Schedule<unknown>} schedule
 * @param {number} attempt
 * @returns {number}
 */
export function retryScheduleDelayMs(schedule, attempt) {
    const safeAttempt = Math.max(1, Math.floor(attempt));
    let state = schedule.initial;
    let now = 0;
    let delayMs = 0;
    for (let index = 0; index < safeAttempt; index++) {
        const [nextState, , decision] = Effect.runSync(schedule.step(now, undefined, state));
        if (ScheduleDecision.isDone(decision)) {
            return 0;
        }
        const nextNow = ScheduleIntervals.start(decision.intervals);
        delayMs = Math.max(0, nextNow - now);
        state = nextState;
        now = nextNow;
    }
    return delayMs;
}
