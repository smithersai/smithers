import { expect, test } from "bun:test";
import { toastClearance } from "../src/agent-status/toastClearance";

test("keeps the after-pin anchor when the stack fits", () => {
  expect(toastClearance(220, 120, 844, [{ top: 0, bottom: 100 }])).toEqual({ top: 220, maxHeight: 618 });
});

test("clears wrapped rows, touching edges, nested and unordered controls", () => {
  expect(toastClearance(60, 120, 785, [
    { top: 130, bottom: 170 }, { top: 70, bottom: 120 },
    { top: 90, bottom: 110 }, { top: 40, bottom: 54 },
  ])).toEqual({ top: 176, maxHeight: 603 });
});

test("uses the first fitting gap instead of moving below a distant primary action", () => {
  expect(toastClearance(60, 100, 785, [{ top: 500, bottom: 540 }])).toEqual({ top: 60, maxHeight: 434 });
});

test("scrolls a tall three-card stack in the largest free gap", () => {
  expect(toastClearance(60, 1000, 844, [{ top: 100, bottom: 200 }, { top: 700, bottom: 750 }])).toEqual({ top: 206, maxHeight: 488 });
});

test("clips at the viewport and handles fully occupied and zero-height space", () => {
  expect(toastClearance(-10, 100, 200, [])).toEqual({ top: 6, maxHeight: 188 });
  expect(toastClearance(6, 100, 200, [{ top: 0, bottom: 200 }])).toEqual({ top: 6, maxHeight: 0 });
  expect(toastClearance(300, 100, 200, [])).toEqual({ top: 6, maxHeight: 188 });
  expect(toastClearance(20, 0, 100, [])).toEqual({ top: 20, maxHeight: 74 });
});
