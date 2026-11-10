---
"@smthrs/agent": minor
---

`Budget.reportsTokens` says whether a call's usage carries a token count, and `Usage.unreported` counts the calls whose provider reported none, live and after recovery from the journal or the spend ledger. A caller can now charge such a call something other than zero.
