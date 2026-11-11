---
title: "Page a person from a shell probe"
description: "Report a probe result from a shell script or a cron job with smthrs alerts, page once on Telegram or by email, and acknowledge the alert."
---

A probe that runs from a shell or a schedule, and not as a flow step, reports
what it saw with `smthrs alerts report`. The command records the result in the
project's journal and pages a person once, however many times the probe fails.
Inside a flow step, call `Alerts.report` instead, as
[Raise an alert from a flow step](../../notifications/docs/guides/raise-an-alert-from-a-step.md)
describes. Both write the same journal entry.

## Choose where pages go

Write `.smithers/alerts.json` in the project:

```json
{
  "defaults": { "owner": "oncall", "runbook": "https://runbook.example/site" },
  "probes": {
    "site-freshness": { "afterMs": 0, "repeatMs": 3600000, "severity": "critical" },
    "disk-space": { "afterMs": 600000 }
  },
  "telegram": { "chatId": "-1001234567890" }
}
```

| Field                       | Meaning                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `defaults`                  | `severity`, `owner` and `runbook` for every probe.                                                             |
| `probes.<name>`             | The probe's rule: `afterMs` before it pages, `repeatMs` between reminders, and `severity`, `owner`, `runbook`. |
| `telegram.chatId`           | The Telegram chat a page goes to.                                                                              |
| `email.to`, `email.from`    | The addresses a page goes to, and the sender, through Resend.                                                  |
| `telegram.url`, `email.url` | A provider origin on `127.0.0.1`, `localhost` or `[::1]`, in place of the public one.                          |

A probe the file does not name pages on its first failure, with severity
`warning`. A key the schema does not know, a bad value, or a malformed file
refuses the command with exit status 2 and names the field.

Put the credential in the environment of the process that runs the probe,
never in the file:

| Variable                        | Used when                                          |
| ------------------------------- | -------------------------------------------------- |
| `SMITHERS_ALERT_TELEGRAM_TOKEN` | `telegram` is configured.                          |
| `SMITHERS_ALERT_EMAIL_API_KEY`  | `email` is configured, and Telegram is not usable. |

With neither destination usable, the command records the result and says
`no destination configured; recorded only`, or names the variable that is
missing. The alert stays `raised`, and the first report after a destination is
configured pages it.

## Report from the probe

Pick one owning run id per problem and report into it every time. The id need
not be a run the control plane started:

```bash
#!/bin/sh
behind=$(./minutes-behind)
state=ok
[ "$behind" -gt 60 ] && state=failing
smthrs alerts report --run site --probe site-freshness --state "$state" \
  --summary "site lags main by $behind minutes" --json
```

The first `failing` report opens the condition and pages. Later `failing`
reports page nothing; the alert comes back in `suppressed`. An `ok` report
closes it, and the next `failing` report opens a new alert with a new id.

```json
{
  "runId": "site",
  "probe": "site-freshness",
  "state": "failing",
  "destination": "telegram",
  "delivered": [
    {
      "alertId": "alert:site:site-freshness:1794215520000",
      "condition": "site-freshness",
      "severity": "critical",
      "since": "2026-11-10T09:12:00.000Z",
      "summary": "site lags main by 979 minutes"
    }
  ],
  "failed": [],
  "refused": [],
  "suppressed": []
}
```

| Array        | Meaning                                                            |
| ------------ | ------------------------------------------------------------------ |
| `delivered`  | Paged on this report. A reminder carries `reminder`.               |
| `failed`     | The channel did not take the page. The next report sends it again. |
| `refused`    | The run's inbox is full. The next report tries again.              |
| `suppressed` | Already paged, or acknowledged.                                    |

A failing probe or a failed page still exits 0. The command exits non-zero only
when it could not record the report: a bad file, a bad flag, or a journal
error.

## List what is open

```bash
smthrs alerts list --run site
```

```text
alerts list
site-freshness  delivered  -  2026-11-10T09:12:00.000Z  alert:site:site-freshness:1794215520000  site lags main by 979 minutes
```

Each row is the probe, the state (`raised`, `delivered` or `acknowledged`), who
acknowledged it, when the condition opened, the alert id and the summary.
`--json` prints the same as `{ "runId", "alerts": [...] }`.

## Acknowledge it

The `Alert:` line of the page is the id:

```bash
smthrs alerts ack --run site --id alert:site:site-freshness:1794215520000
```

`--by` names who takes it, and defaults to the operating system user name. An
acknowledged alert is neither paged nor repeated. An id with no open alert on
the run, such as one whose probe has since reported `ok`, is refused with exit
status 1 and the code `alert_not_open`.

## Next

- [Raise an alert from a flow step](../../notifications/docs/guides/raise-an-alert-from-a-step.md):
  the same reports from inside a flow, and the policy in code.
- [CLI reference](../reference/cli/README.md#probe-alerts): the flags.
