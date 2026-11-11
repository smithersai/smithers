---
title: lang.smithers.sh signs in through the hosted broker
status: done
area: authentication
owner: Claude signin-broker
updated: 2026-11-11
links:
  - ../../../vibelang/wiki/decisions/0029-hosted-sign-in-broker.md
  - ../features/sign-in.md
---

lang.smithers.sh (smithersai/lang) signs people in through `HostedAuthBroker`, as vibelang.smithers.sh does, on
Will's ruling of 2026-11-09: no new redirect URL. Two changes landed here for it:

- The broker returns a person who cancels on GitHub to the site's callback with `#error=access_denied&state=<nonce>`
  instead of stranding them on its 400 (decision 0029, "A cancel returns to the site").
- The integrations README documents the site's half of the wire format, which lang implements in VibeLang without
  importing `@smthrs/integrations` into its Worker.

Deployment, for the lead: add `{ "origin": "https://lang.smithers.sh", "secret": <lang's key> }` to smithers.sh's
`HOSTED_AUTH_SITES` and deploy smithers.sh. lang's key lives with lang's deploy; lang's `live/README.md`, "Open
sign-in", has its half.
