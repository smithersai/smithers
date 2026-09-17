# ADR 0005: GitHub synchronization

## Connect the GitHub App

`/github.app [repo]` (today's `repos.app`) → `connector-setup` card, kind
`github`:

```
┌ GitHub App · smithersai/smithers ────────────── ▲ NOT INSTALLED ┐
│ 1  Install the Smithers app on GitHub     [ Open GitHub ]        │
│ 2  Reconcile                              —                      │
│ rate limit · 4 812 of 5 000 · resets 12:40                        │
└──────────────────────────────────────────────────────────────────┘
```

Step 1 opens `install_url` through `openExternal`; step 2 is `Reconcile`
(`github.reconcile`), which posts and re-reads the status. Connected state:
`● CONNECTED · installation 8123 · configured`. The rate-limit line renders
only when `remaining` is below 20% of `limit`, and always on a card whose
call was refused.

## Import a GitHub repository

`/repos.import <owner/repo>` exists (`repo-import` card). It becomes a job
card that polls `import_jobs`:

```
┌ Import · acme/web → acme/web ─────────────────── ● IMPORTING ┐
│ refs 214 of 214 · objects 88 210 of 91 004 · issues 0 of 312  │
│ stage · provisioning_workspace                                │
└──────────────────────────────────────────────────────────────┘
```

Done state links the repository (opens its row in the tree) and, when the
import created one, the workspace card. Failed reads the job's error
verbatim with Retry (`repos.import.retry <jobId>`).

## Rate limits

A GitHub-proxied call refused for rate limit never fails silently: the
card that made it gains the line `GitHub rate limit reached · 0 of 5 000 ·
resets 12:40 · Retry after`, and the Retry action is disabled until the
reset with the time on it. This is a line on the failing card, not a toast
and not a card of its own. The countdown updates at each remaining-minute
boundary. Re-check, Reconcile, and Try again re-enable at the reset without
a store update. The clock stops at the reset or when the card unmounts.

## Connectors surface

The rows offer Local repository, GitHub, and Smithers Cloud. The GitHub row counts installed repositories from their loaded App status.

## Flows

| Flow | Args |
| --- | --- |
| `github.app`, `github.reconcile` | `[repo]` |
| `repos.import`, `repos.import.retry` | `<owner/repo>` / `<jobId>` |
| `github.mirror-sync` | `[repo]` |

`github.mirror-sync` pushes user refs from Smithers to the configured GitHub
destination. Its card shows `owner/repo → GitHub`; GitHub import is the
separate `repos.import` operation. Completion requires the mirror run receipt.
