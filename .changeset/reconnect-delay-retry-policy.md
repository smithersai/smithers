---
"@smthrs/sync": patch
"@smthrs/sandbox": patch
---

`PresenceProtocol.reconnectDelay` and `TerminalProtocol.reconnectDelay` compute their wait with
`RetryPolicy.nextDelay` from `@smthrs/flow` instead of two identical copies of the formula. The waits are unchanged:
1 s, doubling to 30 s, for 10 attempts. An attempt that is not a whole number now has no delay (`undefined`).
`@smthrs/sync` now depends on `@smthrs/flow`.
