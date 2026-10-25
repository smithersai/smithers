---
title: Settle refused clone notifications
status: blocked
area: repositories
owner: clone-toast
updated: 2026-10-25
links: [../decisions/0009-notifications-and-live-work.md]
---

Fixed a permanent launch refusal after persistence: missing Code Storage now settles the matching attempt and its feed row as failed, instead of abandoning Requested. The attempt fence and idempotent replay remain intact. The recorded production clone's first attempt settled `not_found`; the originating clone-feed e2e then pressed Retry and ended on the repository name alone. Its second attempt remained Requested. That spec now requires the incremented attempt's terminal repository row before ending.

Latitude: 70 focused tests pass with 100% statements, branches, functions and lines on RepoApi, CloneFeed and RepoClone. Typecheck and importRules pass. The old launch guard fails the regression. The refusal e2e now checks settlement, reload, retry availability and dismissal across another reload.

Blocked on configured e2e proof: mini-run skips the refusal spec because its slot lacks Code Storage configuration. The existing production retry was resumed through the authenticated durable launch endpoint; complete repository and notification snapshots now show attempt 2 failed `not_found`, notification version 4. No deployment or direct database write was performed. Automatic recovery of an abandoned device's pre-launch request was not added or proven.
