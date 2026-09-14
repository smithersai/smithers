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
