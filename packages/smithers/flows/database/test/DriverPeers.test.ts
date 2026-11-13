import { expect, it } from "vitest"
import manifest from "../package.json" with { type: "json" }

it("declares exact optional peers for the drivers consumers load at runtime", () => {
  expect(manifest.peerDependencies).toEqual({
    effect: "4.1.1",
    "@effect/sql-sqlite-node": "4.1.1",
    "@effect/sql-pg": "4.1.1"
  })
  expect(manifest.peerDependenciesMeta).toEqual({
    "@effect/sql-sqlite-node": { optional: true },
    "@effect/sql-pg": { optional: true }
  })
})
