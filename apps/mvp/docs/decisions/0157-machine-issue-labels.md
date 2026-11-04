# 0157: Provision machine issue labels before creating the issue

Requested by Will, 2026-11-03. Machine `issue/create` ensures repository labels
exist through its existing GitHub call seam, with the shared User-Agent,
answer classification, stored refusal causes and dispatcher hold.

One missing label uses one tick's mutation. The next tick looks again before
creating another label or the issue. Existing labels keep their metadata;
422 `already_exists` is successful concurrent provisioning. Successful label
provisioning does not consume the issue's retry budget. Lost answers retain
the existing retry policy and GET recovers completed label creation.

Strings remain valid; objects add optional six-digit color and a description
of at most 100 characters. New labels default to `ededed` and an empty
description. Admission still rejects `smithers:` names and private content.
The CLI recognizes metadata at a hex color or empty color delimiter, retaining
existing colon names such as `migrate:t3code`.

This extends core admission and the existing machine dispatcher. It uses the
catalog's `@smthrs/integrations` and `@smthrs/flow`; no new client, operation,
queue or retry loop is added. See [machine tokens](../features/machine-tokens.md).
