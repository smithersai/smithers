# 0143: The fleet and its alerts

Date: 2026-10-31. Status: accepted. Builds on [0136](0136-external-agents-on-runners.md) (external agents on runners),
[0141](0141-agent-transcripts.md) (transcripts), [0142](0142-stop-and-steer-external-agents.md) (stop and steer),
[0017](0017-everything-is-a-plugin.md) (plugins) and
[0009](0009-notifications-and-live-work.md) (notifications). Follows rulings PLUGIN-1, DUR-2, AUTH-4 and OBS-5.
Design: slice S5 of the G1/G2 design (its FINAL.md, §4). Will reviews it with the
feature (HOST-3).

## Problem

Fifty agent runs on two runner machines need one place a Maintainer sees all of them, and a person must hear when a run
fails, goes quiet, waits for a runner or costs too much, or a machine stops answering, without anyone watching a page.
The runner stack (0136) keeps jobs in `agent_jobs`, which holds prompts and is rewritten by every heartbeat, so it can't
be what browsers sync.

## Decision

1. **`agent_runs` is the jobs' projection for people,** one row per generation, written only under the job's own key:
   by the job store when the step starts, probes and cancels it, and by the runner routes when a runner claims and
   settles it. No sweep (DUR-2): the step's parked probe, at most every 30 s, is the clock. A heartbeat's facts land on
   `agent_jobs`, and the probe projects them only when something changed.
2. **Two core queries, one shape each per repository:** `core/agent-runs` (Members and up; the account label only for
   Maintainers) and `core/machines` (Maintainers). Fifty runs are fifty rows of one Electric shape.
3. **`plugins/fleet` is a first-party plugin on the public interface** (PLUGIN-1): one `repository` view for
   Maintainers and a `repo.tabs` entry. The factory's Agents view reads the same query.
4. **Five alerts, each one durable `ops/FleetAlert` per incident.** The incident's id is the execution's, so starting it
   twice runs it once. The probe raises stalls, long waits, cost and outages of runners with jobs; `todo/Fail` raises
   failures; `ops/RunnerHealth`, started once a minute by `FlowExecution` alarms as `ops/DatabaseLoad` is, raises outages
   of runners with no job. Each alert puts one `fleet` entry in each recipient's bell and sends on the deployment's
   existing email and Telegram channels with a receipt. Nothing else sends to Telegram.
5. **A stall needs no deadline guess.** A run stalls when it has neither spoken (a transcript event) nor used 5 CPU
   seconds in its process tree for `AGENT_STALL_MINUTES`. The runner reports the tree's CPU seconds on each heartbeat.
6. **Recipients come from the repository's roles** as GitHub gave them (`github_repo_roles`), or the sessions' on the
   deployment's own repository, and the TODO's committer.

## Consequences

- The runner protocol gains optional fields: a claim's `machine`, a heartbeat's `account`, `cpuSeconds` and `usage`.
  Older runners still claim; their runs stall on events alone and show unknown machine facts.
- Who hears an alert is who held the role when GitHub last said so; a demoted Maintainer may hear one more alert until
  their role is read again.
- A runner reads Offline in the view at 45 s and alerts at 60 s: a request marks it seen at most every 10 s, so a
  shorter threshold would alert on a healthy runner.

## Changes from the design (FINAL.md §4)

- **No server-side keyset paging.** One shape per repository syncs all its runs and the view lists every one, which
  meets "a run outside the newest 50 listed". Paging comes when a repository's history outgrows a shape.
- **Run failed or lost** is raised by `todo/Fail` rather than folded by the stack's report, so it reaches the channels
  as the other four do. A run that dies never reaches `todo/Fail`, so `settleCrashed` raises it too, and marks the run's
  open generations Failed `crashed`: no probe is left to project them.
- **Runner offline alerts at 60 s, not 90 s,** so an outage reaches the bell within 90 s of the runner's death, as the
  e2e requires.
- **Not built:** `/app/fleet` for Admins across repositories, Steer and Stop as row acts (S3's, on the TODO's page),
  and containers beside the runners.
