---
title: "Google Calendar"
description: "Read and write a Google Calendar safely under retry: token refresh, deterministic event ids, upsert/patch/cancel/free-busy actions, and a syncToken change feed of source records."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/integrations/docs/guides/google-calendar.md"
---

How to use the Google Calendar adapter. It is library code: no host in this
repository wires it yet. The [API reference](/reference/api/#google-calendar) has the
full signatures.

## Configure a client

For a script or a test, the client reads explicit configuration, then the
environment:

| Variable                                | Meaning                                          |
| --------------------------------------- | ------------------------------------------------ |
| `SMITHERS_GOOGLE_ACCESS_TOKEN`          | A static access token. Expires within the hour.  |
| `SMITHERS_GOOGLE_CLIENT_ID`             | The OAuth client id.                             |
| `SMITHERS_GOOGLE_CLIENT_SECRET`         | The OAuth client secret, for a confidential app. |
| `SMITHERS_GOOGLE_REFRESH_TOKEN`         | A refresh token. A rotated one is not persisted. |
| `SMITHERS_GOOGLE_TOKEN_URL`             | The token endpoint, for a fixture server.        |
| `SMITHERS_GOOGLE_CALENDAR_API_BASE_URL` | The API root, for a fixture server.              |

A host that keeps the refresh token in the credential store uses
`GoogleCalendar.CalendarClient.layerFromConnection(connection, { principal, authorize })`.
Every read of the refresh token goes through `Core.Connection.resolveSecret`,
so the host policy (for example `Core.Connection.personalPolicy`) decides
before the broker is asked, and a rotated refresh token is written back with
a compare-and-set. The connection's containers are the calendars the client
may touch.

## Write events that survive a retry

`GoogleCalendar.Actions.UpsertEvent` inserts under an id derived from your key
(`EventId.fromKey`). If the answer is lost, the engine repeats the step,
Google refuses the duplicate id with a 409, and the action reads the event
back: the same event is `created: false`, a different one fails
`EventConflict`. `PatchEvent` and `CancelEvent` address a recurring event's
single occurrence by the series id and its `originalStart`. `FreeBusy` reads
availability. Writes send no attendee email unless the payload sets
`sendUpdates`.

## Follow a calendar

`GoogleCalendar.Sync.make({ … })` builds a `Core.Sync` adapter over the `CalendarClient` in context. The first run
lists every event and marks the listing `reset`; later runs ask for changes
since the stored `syncToken`. A `410 Gone` starts a fresh listing instead of
failing. Cancelled events and occurrences become tombstones. Records are
`private` to the calendar by default.
