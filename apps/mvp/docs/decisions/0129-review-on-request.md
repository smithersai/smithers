# 0129: Review on request: a Maintainer asks Smithers to review any open pull request

Date: 2026-10-30. Status: accepted. Builds on [0012](0012-git-end-to-end.md) decision 12 (checks are Smithers runs),
[0079](0079-roles-per-repository.md) (per-repository roles), [0099](0099-hosted-inference-flag.md) and
[0107](0107-model-tiers.md) (the review's model and tier). Will reviews it with the feature (HOST-3).

## Problem

`checks/Review` runs only inside `checks/Run`, which starts when a TODO's run publishes its head. A pull request a person
or an outside agent opened never gets a Smithers review, so a Maintainer of `smithersai/vibelang` on smithers.sh can't
ask for one.

## Decision

1. **A person asks, in person.** `pull/review { repo, number, headSha? }` is a client flow whose one step sends
   `POST /api/repos/<owner>/<name>/pulls/<number>/review`. It is person-only (`PERSON_ONLY_FLOWS`): the agent, a flow, a
   frame or a sandbox is refused `403 person_only`, and counted. Doors: Review on the pull request page, and
   `/review <owner/name> <number>`.
2. **Who.** A Maintainer or Admin of the pull request's repository, through `RepoRoles` (0079), on any repository the
   deployment acts on (`mayAct`: `GITHUB_REPOSITORY`, or one with the App installed and allowed). The review spends a
   model, so it takes `repo:merge`'s tier, not a Member's. A Member, a reader or no role is `403 forbidden`.
3. **What runs.** `pull/Review` on the server: the existing `checks/Review` then `checks/Report`, no scripts and no
   machine. The judge reads the head's diff from GitHub with the requester's reviewer seat (`reviewerFor(ownerId)`), the
   App posts its findings as one `COMMENT` review "Reviewed by Smithers for @<login>", and `smithers/review` reports the
   result on the head. Agents never approve or merge.
4. **One review per head.** The route claims the head's `checks/review` run row (the id `checks/Run` uses) and starts
   the flow in one transaction. A review Running or Passed answers `202 { started: false }`; a Failed one is claimed again,
   for the new requester, with a new execution id (`review:<repoId>:<sha>:<claimedAtMs>`). A start the host couldn't
   record rolls the claim back. Another check of the head Running is `409 checks_running`: `checks/Run` reviews it after
   its scripts.
5. **Bound to the page.** The button sends the head it shows; a newer head is `409 head_moved`. `/review` names no head
   and reviews the current one. A merged or closed pull request is `409 closed`; one Smithers hasn't projected is `404`.
6. **Refusals.** `401 authentication`, `403 forbidden`, `403 person_only`, `404 not_found` / `app_not_installed`,
   `409 head_moved` / `closed` / `checks_running`, `400 invalid`, `503 not_configured` (no App) / `unavailable` /
   `github_unavailable`, `429 rate_limited`. The device step tries again, for ten minutes, on a `429`, a `5xx` other than
   `not_configured`, or no answer; any other refusal is final.

## Consequences

- Observability: `pull.review.request` (server span and log) and `smithers_pull_review_requests{outcome}`; on the device,
  `pulls.review.post` and `smithers_web_pull_reviews{outcome}`. Ids, SHAs, statuses and codes only, never a title, a
  diff or a finding.
- Not built: reviewing again a head whose review passed, and an automatic review of every opened pull request.
