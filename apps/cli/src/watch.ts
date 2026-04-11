const CLEAR_SCREEN_SEQUENCE = "\x1B[2J\x1B[0f";

export const WATCH_MIN_INTERVAL_MS = 500;

export type WatchRenderContext = {
  tickCount: number;
  initial: boolean;
};

export type WatchLoopResult<T> = {
  intervalMs: number;
  tickCount: number;
  stoppedBySignal: boolean;
  reachedTerminal: boolean;
  signal?: NodeJS.Signals;
  lastData: T;
};

export type WatchLoopOptions<T> = {
  intervalSeconds: number;
  clearScreen?: boolean;
  fetch: () => Promise<T>;
  render: (snapshot: T, context: WatchRenderContext) => Promise<void> | void;
  isTerminal?: (snapshot: T) => boolean;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function clampWatchIntervalMs(requestedMs: number): number {
  if (!Number.isFinite(requestedMs) || requestedMs <= 0) {
    throw new Error("Watch interval must be greater than 0 seconds.");
  }
  return Math.max(Math.floor(requestedMs), WATCH_MIN_INTERVAL_MS);
}

export function watchIntervalSecondsToMs(intervalSeconds: number): number {
  return clampWatchIntervalMs(intervalSeconds * 1_000);
}

function clearTerminalScreen() {
  process.stdout.write(CLEAR_SCREEN_SEQUENCE);
}

export async function runWatchLoop<T>(
  options: WatchLoopOptions<T>,
): Promise<WatchLoopResult<T>> {
  const intervalMs = watchIntervalSecondsToMs(options.intervalSeconds);
  let tickCount = 0;
  let stoppedBySignal = false;
  let signal: NodeJS.Signals | undefined;
  let signalHandled = false;

  let resolveSignalPromise: ((value: "signal") => void) | undefined;
  const signalPromise = new Promise<"signal">((resolve) => {
    resolveSignalPromise = resolve;
  });

  const handleSignal = (nextSignal: NodeJS.Signals) => {
    if (signalHandled) return;
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
    const renderSnapshot = async (snapshot: T, initial: boolean) => {
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
        sleep(intervalMs).then(() => "tick" as const),
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
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}
