import { initialSetup, setupCandidate } from "@smthrs/rpc/RepositorySetup"
import type { RepositoryJob, RepositorySetup } from "@smthrs/rpc/RepositorySetup"
import { expect, test } from "bun:test"
import type { Card } from "./AppState"
import { repositoryJobState, repositoryJobStates } from "./RepositoryJobs"

/*
 * The canary's own census, verbatim (.artifacts/mvp-canary-walk-20260917/
 * W1-g-discard-and-retry.json): two jobs of one repository, each with the
 * registration the host answered with, read in the SAME census.
 *
 *   L76-issuesBefore   activeEnabled false, activeRevision 4
 *   featureStateBefore active { enabled: true, revision: 57 }
 *   jobButtonsWithState  "Handle issues · Paused" … "Build a feature"
 *
 * The walk booted into that census, and boot re-reads every setup card's
 * registration (controller/repositorySetup.ts resumeRepositorySetups →
 * requestRecovery), which parks `registrationState` back at "unknown" while
 * the read is in flight and at "unavailable" when it fails. A registration
 * the card is HOLDING does not stop being known because it is being read
 * again, so both buttons must read their own state.
 */
const REPO = "codeplanesmithers/canary-sandbox"
const OWNER = "codeplanesmithers"

const setup = (job: RepositoryJob, active: { readonly enabled: boolean; readonly revision: number },
  recovery: RepositorySetup["recovery"]): RepositorySetup => {
  const payload = initialSetup(REPO, job, OWNER)
  const digest = setupCandidate(payload)
  return {
    ...payload,
    revision: active.revision,
    active: { revision: active.revision, digest, registrationId: `reg-${job}`, sourceRevision: "f4d4814e", enabled: active.enabled },
    ...(recovery === undefined ? {} : { recovery })
  }
}

const card = (job: RepositoryJob, payload: RepositorySetup): Card => ({
  id: `setup:${OWNER}:${encodeURIComponent(REPO)}:${job}`, kind: "repository-setup", title: job,
  status: "active", createdAt: 1, ordinal: 1, payload
})

const known = (payload: RepositorySetup): RepositorySetup["recovery"] =>
  ({ id: "rec-known", baseRevision: payload.revision, baseDigest: setupCandidate(payload), state: "completed", registrationState: "known" })

test("a registration the card holds is read while its re-read is still in flight", () => {
  const issues = setup("issues", { enabled: false, revision: 4 }, undefined)
  const feature = setup("feature", { enabled: true, revision: 57 }, undefined)
  const issuesCard = card("issues", { ...issues, recovery: known(issues) })
  const inFlight = card("feature", { ...feature, recovery: { id: "rec-1", baseRevision: 57, baseDigest: setupCandidate(feature), state: "requested", registrationState: "unknown" } })
  const unavailable = card("feature", { ...feature, recovery: { id: "rec-2", baseRevision: 57, baseDigest: setupCandidate(feature), state: "failed", registrationState: "unavailable", error: "The registration could not be read." } })
  expect(repositoryJobState(issuesCard.kind === "repository-setup" ? issuesCard.payload : issues)).toBe("Paused")
  expect(repositoryJobState(inFlight.kind === "repository-setup" ? inFlight.payload : feature)).toBe("Enabled")
  expect(repositoryJobState(unavailable.kind === "repository-setup" ? unavailable.payload : feature)).toBe("Enabled")
  expect(repositoryJobStates([issuesCard, inFlight], REPO, OWNER)).toEqual({ issues: "Paused", feature: "Enabled" })
})

test("a registration nothing has answered for yet is still not a state", () => {
  const fresh = initialSetup(REPO, "review", OWNER)
  const pending = { ...fresh, recovery: { id: "rec-3", baseRevision: fresh.revision, baseDigest: setupCandidate(fresh), state: "requested" as const, registrationState: "unknown" as const } }
  expect(repositoryJobState(pending)).toBeUndefined()
  expect(repositoryJobStates([card("review", pending)], REPO, OWNER)).toEqual({})
})
