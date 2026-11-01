import { expect, test } from "bun:test";
import { decideTranscriptScroll } from "../src/chat/transcriptScroll";

const viewport = { scrollTop: 0, clientHeight: 600, scrollHeight: 1800 };
const short = { top: 1400, height: 200 };

test("an arrival shows the current repository heading and keeps follow armed", () => {
  expect(decideTranscriptScroll({ following: false }, viewport, { top: 500, height: 100 }, "arrival"))
    .toEqual({ top: 490, following: true });
  expect(decideTranscriptScroll({ following: false }, viewport, short, "arrival"))
    .toEqual({ top: 1200, following: true });
  expect(decideTranscriptScroll({ following: false }, viewport, { top: 800, height: 900 }, "arrival"))
    .toEqual({ top: 790, following: true });
});
test("a send or card door resumes follow from the first-paint position", () => {
  expect(decideTranscriptScroll({ following: false }, viewport, short, "user"))
    .toEqual({ top: 1200, following: true });
});
test("a tall new answer starts at its top instead of skipping to its tail", () => {
  expect(decideTranscriptScroll({ following: true }, { ...viewport, scrollHeight: 2500 }, { top: 1400, height: 1100 }, "output"))
    .toEqual({ top: 1390, following: true });
});
test("streaming follows short output but never fights a reader who scrolled up", () => {
  expect(decideTranscriptScroll({ following: true }, viewport, short, "output").top).toBe(1200);
  expect(decideTranscriptScroll({ following: false }, { ...viewport, scrollTop: 300 }, short, "output"))
    .toEqual({ top: null, following: false });
});
test("targets clamp to the available scroll range", () => {
  expect(decideTranscriptScroll({ following: true }, { scrollTop: 0, clientHeight: 600, scrollHeight: 200 }, { top: 10, height: 100 }, "user").top).toBe(0);
});
/*
 * Production 20261015 (UI 10a823b3, run 38764661812): in a saved shared
 * conversation `/issues.create` then `/issues.list` navigated the repository's
 * ONE pane card, which keeps its place early in the transcript, while the
 * composer's flow form stayed last. The read scrolled to the live edge, so the
 * created issue and the refreshed list were never on screen.
 */
test("a requested read above the live edge lands on its own entry and stops following", () => {
  const tall = { scrollTop: 0, clientHeight: 640, scrollHeight: 5200 };
  expect(decideTranscriptScroll({ following: true }, tall, { top: 420, height: 300 }, "user"))
    .toEqual({ top: 410, following: false });
  // Passive output still follows the live edge; only the asked-for read moves.
  expect(decideTranscriptScroll({ following: true }, tall, { top: 420, height: 300 }, "output"))
    .toEqual({ top: 4560, following: true });
  // An unmeasured entry states no position; it must not send the reader to the top.
  expect(decideTranscriptScroll({ following: true }, tall, { top: 0, height: 0 }, "user"))
    .toEqual({ top: 4560, following: true });
});

test("an explicit read interrupts deferred follow before its scroll event arrives", async () => {
  const { transcriptFollowInterrupted } = await import("../src/chat/transcriptScroll");
  expect(transcriptFollowInterrupted(1200, { scrollTop: 300, clientHeight: 600, scrollHeight: 2400 }, 64)).toBe(true);
  // Content growth without a new scroll position keeps following armed.
  expect(transcriptFollowInterrupted(1200, { scrollTop: 1200, clientHeight: 600, scrollHeight: 2400 }, 64)).toBe(false);
  // Browser anchoring at the new bottom and end clamping preserve the live edge.
  expect(transcriptFollowInterrupted(1200, { scrollTop: 1800, clientHeight: 600, scrollHeight: 2400 }, 64)).toBe(false);
  expect(transcriptFollowInterrupted(1200, { scrollTop: 0, clientHeight: 600, scrollHeight: 300 }, 64)).toBe(false);
  expect(transcriptFollowInterrupted(300, { scrollTop: 301, clientHeight: 600, scrollHeight: 2400 }, 64)).toBe(false);
  expect(transcriptFollowInterrupted(1700, { scrollTop: 1736, clientHeight: 600, scrollHeight: 2400 }, 64)).toBe(false);
  expect(transcriptFollowInterrupted(1700, { scrollTop: 1735, clientHeight: 600, scrollHeight: 2400 }, 64)).toBe(true);
});
