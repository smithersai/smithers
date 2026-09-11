import { describe, expect, test } from "bun:test";
import { formatStatus, hasStatusTone, isTerminalRunStatus, statusClass } from "../src/status";

/**
 * The rc.0 run vocabulary and the run-card phases apps/app renders beside it.
 *
 * Every addition here is additive: no status that already had a tone changed
 * one, which is what keeps a consumer's colors stable across the upgrade.
 */

/** `@smthrs/control` `RunStatus`, in full. */
const RUN_STATUSES = [
  "accepted",
  "running",
  "parked",
  "waiting-approval",
  "cancelled",
  "completed",
  "failed",
] as const;

/** The run-card phases apps/app passes beside the engine's own statuses. */
const CARD_PHASES = [
  "launching",
  "running",
  "waiting-approval",
  "reconnecting",
  "quiet",
  "stopped",
  "completed",
  "failed",
  "cancelled",
  "no-capacity",
] as const;

describe("the rc.0 run status vocabulary", () => {
  test("every run status has a tone, and none falls through to unknown", () => {
    // `statusClass` returns "muted" both for a status deliberately bucketed
    // neutral and for one it never heard of, so only `hasStatusTone`
    // distinguishes a mapped status from the fallback.
    expect(RUN_STATUSES.filter((status) => !hasStatusTone(status))).toEqual([]);
    expect(RUN_STATUSES.map(statusClass)).toEqual([
      "muted", // accepted: taken, nothing in flight yet
      "run",
      "warn", // parked: holding on the world
      "warn",
      "muted", // a user cancel is neutral, not a failure
      "ok",
      "bad",
    ]);
  });

  test("every run status has a human label", () => {
    expect(RUN_STATUSES.map(formatStatus)).toEqual([
      "Accepted",
      "Running",
      "Parked",
      "Waiting for approval",
      "Cancelled",
      "Complete",
      "Failed",
    ]);
  });

  test("the three terminal statuses are terminal and the four live ones are not", () => {
    expect(RUN_STATUSES.filter(isTerminalRunStatus)).toEqual(["cancelled", "completed", "failed"]);
  });
});

describe("the run-card phases", () => {
  test("every phase apps/app passes has a tone", () => {
    expect(CARD_PHASES.map(statusClass)).toEqual([
      "run", // launching
      "run",
      "warn",
      "warn", // reconnecting: the read path is down, not the run
      "warn", // quiet: nothing moved for the bound
      "muted", // stopped: the human stopped watching
      "ok",
      "bad",
      "muted",
      "warn", // no-capacity: the workspace could not be provisioned
    ]);
  });

  test("every phase has a human label rather than a title-cased slug", () => {
    // `quiet` keeps the mechanical fallback on purpose. apps/app's run card has
    // always worn a "Quiet" pill and its CardFrames suite pins that string, so
    // a label entry here would have changed a rendered label rather than added
    // a missing one.
    expect(formatStatus("quiet")).toBe("Quiet");
    expect(formatStatus("no-capacity")).toBe("No capacity");
    expect(formatStatus("launching")).toBe("Launching");
    expect(formatStatus("reconnecting")).toBe("Reconnecting");
    expect(formatStatus("stopped")).toBe("Stopped");
  });
});

describe("the additions are additive", () => {
  test("no status that already had a tone changed one", () => {
    expect(statusClass("running")).toBe("run");
    expect(statusClass("completed")).toBe("ok");
    expect(statusClass("waiting-approval")).toBe("warn");
    expect(statusClass("cancelled")).toBe("muted");
    expect(statusClass("failed")).toBe("bad");
    expect(statusClass("queued")).toBe("muted");
    expect(statusClass("pending")).toBe("muted");
  });

  test("a status outside the vocabulary is still neutral, never invented", () => {
    expect(statusClass("something-new")).toBe("muted");
    expect(formatStatus("something-new")).toBe("Something New");
    expect(hasStatusTone("something-new")).toBe(false);
    // The one Object.prototype key `normalizeStatus` can produce is the same
    // kind of miss, not a resolved constructor. See status-prototype-keys.
    expect(statusClass("constructor")).toBe("muted");
    expect(formatStatus("constructor")).toBe("Constructor");
  });

  test("every run-card phase is mapped rather than falling through", () => {
    expect(CARD_PHASES.filter((phase) => !hasStatusTone(phase))).toEqual([]);
  });
});
