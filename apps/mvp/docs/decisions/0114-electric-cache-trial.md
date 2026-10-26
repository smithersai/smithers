# 0114: Keep the Electric cache private; do not activate an unproven live cache

Status: accepted for the credential boundary; cache activation blocked on production proof.

ChatApi authorizes each shape before the private service binding. The binding must remove legacy Electric credentials even when an older deployment retains them in its environment. The host adapter strips the `secret` query parameter and Authorization/Cookie headers before the binding call. This leaves the generic SDK's authenticated Electric connections unchanged and prevents credentials entering this cache key or platform subrequest URL.

The S5 experiment enabled Alchemy's Workers Cache on the gateway with `crossVersionCache: false`. Its key comprises the canonical upstream URL, entrypoint and Worker version, retaining the full authorized definition and protocol parameters, including person/repository scope, handle, offset, cursor, expired handle and cache buster. Browser responses stay `private, no-store`. Only Electric-marked public HTTP 200 responses were eligible; 401/403/409/429/5xx and SSE were not. Authorization remains outside and ahead of cache lookup.

Non-live cache hits were observed. The mixed 70-device load failed on both `basic` and `standard-1`, including a repeat after the size rollout settled. The measured limits and pricing estimates are in [infrastructure](../infrastructure.md#electric-s5-cache-trials-2026-10-26). Production was restored to main after each trial. Neither enabling the cache nor increasing the instance size is approved by this evidence.

Before activation, prove same-key live request collapsing on the deployed service-binding path, then the full load/freshness/write-latency bar, two-person tagged-row isolation, 409/expired-handle recovery after a deliberate restart, and 30% live-poll cancellation. The second production identity is currently missing. Do not replace managed collapsing with an isolate-local Promise map or a second singleton object. Sharding remains conditional on measured distinct-scope breadth after collapsing works.

Library catalog: `@smthrs/effect-electric` supplies the shape proxy and its injected `Upstream`; Alchemy supplies the existing Cloudflare host binding. No new dependency or product feature is introduced.
