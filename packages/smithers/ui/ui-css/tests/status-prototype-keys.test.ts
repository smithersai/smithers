import { describe, expect, test } from "bun:test";
import { formatStatus, hasStatusTone, statusClass, statusColor } from "../src/status";
import { tokens } from "../src/tokens";

/**
 * A status string is host data: it arrives from an engine row, a card phase, a
 * sandbox state, or a 0.x archive listing. `normalizeStatus` lowercases, so the
 * one `Object.prototype` key it can produce is `constructor`
 * (`toString`/`valueOf`/`hasOwnProperty` fold to spellings no prototype
 * carries). Every lookup in this module must miss it the way it misses any
 * other unrecognized string, because a resolved `Object` constructor rendered
 * as a React child throws "Functions are not valid as a React child".
 */
const PROTOTYPE_KEYS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"] as const;

describe("status lookups never resolve through Object.prototype", () => {
  test("statusClass falls back to muted for every prototype key", () => {
    for (const key of PROTOTYPE_KEYS) {
      expect(`${key}=${statusClass(key)}`).toBe(`${key}=muted`);
    }
  });

  test("statusColor resolves to the muted token for every prototype key", () => {
    for (const key of PROTOTYPE_KEYS) {
      expect(`${key}=${statusColor(key)}`).toBe(`${key}=${tokens.mutedForeground}`);
    }
  });

  test("formatStatus title-cases a prototype key instead of returning a function", () => {
    expect(formatStatus("constructor")).toBe("Constructor");
    expect(formatStatus("valueOf")).toBe("Valueof");
    expect(typeof formatStatus("constructor")).toBe("string");
  });

  test("hasStatusTone reports a real miss for a prototype key", () => {
    for (const key of PROTOTYPE_KEYS) {
      expect(`${key}=${hasStatusTone(key)}`).toBe(`${key}=false`);
    }
  });

  test("hasStatusTone reports a hit for a mapped status and a miss for an unknown one", () => {
    expect(hasStatusTone("running")).toBe(true);
    expect(hasStatusTone("waiting-anything")).toBe(true);
    expect(hasStatusTone("something-new")).toBe(false);
    expect(hasStatusTone(undefined)).toBe(false);
  });
});
