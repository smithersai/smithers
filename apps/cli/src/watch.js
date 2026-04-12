// @smithers-type-exports-begin
/** @typedef {import("./watch.ts").WatchRenderContext} WatchRenderContext */
// @smithers-type-exports-end


/** @typedef {import("./watch.ts").watch} watch */

/** @typedef {import("./watch.ts").WatchLoopOptions} WatchLoopOptions */
/** @typedef {import("./watch.ts").WatchLoopResult} WatchLoopResult */
const CLEAR_SCREEN_SEQUENCE = "\x1B[2J\x1B[0f";
export const WATCH_MIN_INTERVAL_MS = 500;
/**
 * @param {number} ms
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * @param {number} requestedMs
 * @returns {number}
 */
export function clampWatchIntervalMs(requestedMs) {
    if (!Number.isFinite(requestedMs) || requestedMs <= 0) {
        throw new Error("Watch interval must be greater than 0 seconds.");
    }
    return Math.max(Math.floor(requestedMs), WATCH_MIN_INTERVAL_MS);
}
/**
 * @param {number} intervalSeconds
 * @returns {number}
 */
export function watchIntervalSecondsToMs(intervalSeconds) {
    return clampWatchIntervalMs(intervalSeconds * 1_000);
}
function clearTerminalScreen() {
    process.stdout.write(CLEAR_SCREEN_SEQUENCE);
}
/**
 * @template T
 * @param {WatchLoopOptions<T>} options
 * @returns {Promise<WatchLoopResult<T>>}
 */
export async function runWatchLoop(options) {
    const intervalMs = watchIntervalSecondsToMs(options.intervalSeconds);
    let tickCount = 0;
    let stoppedBySignal = false;
    let signal;
    let signalHandled = false;
    let resolveSignalPromise;
    const signalPromise = new Promise((resolve) => {
        resolveSignalPromise = resolve;
    });
    /**
   * @param {NodeJS.Signals} nextSignal
   */
    const handleSignal = (nextSignal) => {
        if (signalHandled)
            return;
        signalHandled = true;
        stoppedBySignal = true;
        signal = nextSignal;
        resolveSignalPromise?.("signal");
    };
    const onSigint = () => handleSignal("SIGINT");
    const onSigterm = () => handleSignal("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    try {
        /**
     * @param {T} snapshot
     * @param {boolean} initial
     */
        const renderSnapshot = async (snapshot, initial) => {
            if (!initial && (options.clearScreen ?? true)) {
                clearTerminalScreen();
            }
            await options.render(snapshot, { tickCount, initial });
        };
        const initial = await options.fetch();
        await renderSnapshot(initial, true);
        if (options.isTerminal?.(initial)) {
            return {
                intervalMs,
                tickCount,
                stoppedBySignal: false,
                reachedTerminal: true,
                lastData: initial,
            };
        }
        let latest = initial;
        while (true) {
            const waitResult = await Promise.race([
                sleep(intervalMs).then(() => "tick"),
                signalPromise,
            ]);
            if (waitResult === "signal") {
                return {
                    intervalMs,
                    tickCount,
                    stoppedBySignal,
                    reachedTerminal: false,
                    signal,
                    lastData: latest,
                };
            }
            tickCount += 1;
            latest = await options.fetch();
            await renderSnapshot(latest, false);
            if (options.isTerminal?.(latest)) {
                return {
                    intervalMs,
                    tickCount,
                    stoppedBySignal: false,
                    reachedTerminal: true,
                    lastData: latest,
                };
            }
        }
    }
    finally {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
    }
}
