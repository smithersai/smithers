# 0110: Decide shape authority before requesting a shape

Status: accepted implementation of Will's 2026-10-25 signed-out-shapes request.

Repository shape requests wait for the device session's role. A visitor may also read when the deployment repository's role answer carries an explicit public-read receipt, checked with the same policy the server applies to shapes. A receipt earned under a signed-in role does not grant anonymous access.

Issues and pulls derive access from these device records. A refused or failed shape records unavailability, never sign-in status or role. Installed receipts remain separate from authorization. The server still authorizes every request.

Library catalog entries: `@smthrs/effect-electric`, `@smthrs/effect-tanstack-db`.

TODO and prompt shapes use the same request gate, with Member authority resolved for their named repository. Public repository visibility alone does not grant stack access.

## W9 follow-up: repository actions

Repository flow runs remain Member-only, including on a public repository (actions feature and decision 0012).
The actions shape waits for a signed-in Member, Maintainer or Admin on its named repository. An absent authority
store fails closed. The deployment's session role applies only to its own repository; a public-read receipt does
not grant access to runs. The browser uses the catalog's `@smthrs/effect-electric` `ShapeSource.gated`.
