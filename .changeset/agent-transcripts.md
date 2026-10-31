---
"@smthrs/agent": minor
---

Adds `Transcript`, what a runner sends its host of an external agent's session as it happens: numbered events
(`Event`, `EventsRequest`, `EventsResponse`, posted to the new `AgentRunner.ROUTES.events`), `prepare`, which drops an
agent's slash commands and configuration options, scrubs every string and bounds an event to 16 KiB by splitting a long
message or cutting any other long string, and `scrubber`, the credential and email shapes every runner and host scrub.
