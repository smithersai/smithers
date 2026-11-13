/**
 * Review claims keep the same person attribution in active and passive voice.
 *
 * @since 0.1.0
 */

import { strict as assert } from "node:assert"
import { test } from "node:test"
import { bannedClaimsScore } from "./scoring.ts"

test("passive review claims require the same person identifiers as active claims", () => {
  const score = (html: string) => bannedClaimsScore({ dist: "x", html }).score
  for (const subject of ["Smithers", "the agent", "agent", "Codex", "Claude Code", "automation", "the system", "Mayabot", "reviewer-bot"]) {
    for (const verb of ["Reviewed", "Reviewed and approved", "REVIEWED"]) {
      const html = `${verb} by ${subject}.`
      assert.equal(score(html), 0, html)
    }
  }
  for (const subject of ["Maya", "cora", "dev-ahn", "Will", "Ada", "you", "the person", "the reviewer", "@maya", "${role}"]) {
    for (const verb of ["Reviewed", "Reviewed and approved", "REVIEWED"]) {
      const html = `${verb} by ${subject}.`
      assert.equal(score(html), 1, html)
    }
  }
  assert.equal(score("Reviewed by Maya. Reviewed by Smithers."), 0)
})
