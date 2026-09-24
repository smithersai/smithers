# smithers.sh browser canary

Owner: Smithers release operator. The [Canary workflow](../../../.github/workflows/canary.yml) runs from `smithersai/smithers` against `https://smithers.sh`. The fork guard is its only condition: no repository variable switches it off. It is scheduled every quarter hour for uptime and hourly for the browser and metered checks, but GitHub delivers only 10 to 15 of this repository's scheduled ticks a day (measured 2026-09-12..23), so expect detection within one to three hours. A failed check creates or updates the fixed `Canary: smithers.sh is failing` issue, assigned to the operator (`ALERT_ASSIGNEES` in `apps/server/scripts/canary/uptime-checks.ts`), then makes the job red. Later failures comment on the open issue. Only a passing run that includes the browser step (hourly or dispatched) closes it; a quarter-hour uptime pass leaves an open alert for the next full run.

## Configuration

Configure `CANARY_SESSION_COOKIE` as a valid ordinary non-admin test session cookie header, `CANARY_SESSION_LOGIN` as that login, `CANARY_BROWSER_REPO` as a private fixture repository owned by that account, `CANARY_BROWSER_WORKSPACE` as the existing fixture workspace UUID, and `CANARY_BROWSER_FLOW` as a configured, safe, input-free flow in that workspace which runs long enough to observe a running state (at least 20 seconds) and completes without approval or repository mutation. The saved `codeplanesmithers` account is in the identity Worker's `ADMIN_LOGINS` today, so it cannot qualify this canary; `apps/HUMAN-TASKS.md` H5 tracks the scoped-down account. Rotate the cookie before the session expires. The workflow target is pinned to the apex, so a repository variable cannot redirect its browser to a preview host.

When the cookie, flow, or workspace is unset, `scripts/canary-browser.ts` writes `result.json` with `status: "skip"` and the unset variable names, and exits 0. The alert decision reads that as a `skip` row and the run prints a `::warning` naming them: a missing canary secret is a configuration state, not an outage, and never opens the issue. A configured cookie that is signed out, belongs to another login, has no `CANARY_SESSION_LOGIN`, or carries `admin: true` fails the check.

## What the browser proves

The fresh context proves signed-out boot and editable Chat. A separate isolated context receives only the scoped cookie, verifies the account, selects the fixture workspace, renders the Files browse, opens setup, and holds the actual flow launch response while checking Chat. It releases that response, records the accepted run ID, checks Chat during execution, and requires a completed remote projection and rendered run receipt. Its `canary-browser` artifact contains screenshots and `result.json`, including the run ID but no cookie. No persistent profile is involved in scheduled runs.

## On alert

Inspect the Actions run and its `canary-browser` and `canary-uptime-report` artifacts. Check the accepted run ID and terminal projection before retrying a run; an ambiguous launch may already have created a job. Restore the fixture or session if configuration failed, then dispatch the workflow again. A healthy dispatched run closes the issue.

## Delivery drill

Run `gh workflow run canary.yml -R smithersai/smithers -f force_failure=true`. The drill adds one deliberate failing `alert delivery drill` row to the report, so it works whether or not the browser fixture exists. Verify a red run, the drill row in the issue body, the issue assigned to the operator, and the operator's notification. Then run `gh workflow run canary.yml -R smithersai/smithers` and verify the close comment. Record the run URLs, issue URL, recipient, and notification receipt time here. Do not infer delivery from issue creation alone.
