import { Schema } from "effect"
import { expect, test } from "vitest"
import { ReadRefs, RepoRefs } from "./flows"

test.each([{}, { refsChangedAt: null }, { refsChangedAt: "2026-10-31 12:34:56.123456+00" }])(
  "recorded refs results retain their revision, including results before it was carried: %j",
  (revision) => {
    const recorded = { defaultBranch: "main", head: "a".repeat(40), branches: [], tags: [], truncated: false, ...revision }
    expect(Schema.decodeUnknownSync(ReadRefs.successSchema)(recorded)).toEqual(recorded)
    expect(Schema.decodeUnknownSync(RepoRefs.successSchema)(recorded)).toEqual(recorded)
  },
)
