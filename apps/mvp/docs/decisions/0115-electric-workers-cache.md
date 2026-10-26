# 0115: Electric behind Workers Cache with live collapse

Date: 2026-10-26. Status: accepted for implementation; deployment proof belongs to the lander.

## Decision

Enable Alchemy's Workers Cache on ElectricGateway's private service-binding entrypoint,
with `crossVersionCache: false`. The key is the complete canonical URL emitted by
`@smthrs/effect-electric` ShapeProxy plus the gateway version. Shape definition
(table, columns, where and person/repository parameters), handle, offset, cursor,
expired_handle and cache-buster all participate. Authorization remains in ChatApi,
before the cache. Legacy Electric secrets, Authorization and Cookie are stripped
before invoking the binding. No authentication material participates in the key.

Keep Electric's own public cache-control on HTTP 200 finite responses, including
live long polls; deny other statuses, missing/nonpublic policy, contradictory
private/no-store/no-cache, and either SSE form. In particular, never cache
401/403/409/429/5xx. ShapeProxy keeps browser responses `private, no-store`.
Set `ELECTRIC_LONG_POLL_TIMEOUT=10000`; this ends an empty poll after ten seconds,
not a ten-second TTL. Live answers retain Electric's five-second max-age and
five-second stale-while-revalidate. No application promise map, retry loop or queue.

Library catalog entry: **Sync Postgres rows into a collection through Electric,
and proxy its shapes from your server** (`@smthrs/effect-electric`). Alchemy's
existing Cloudflare host supplies the [Workers Cache](https://v1.alchemy.run/providers/cloudflare/cache/).
This is hosting infrastructure for every shape, not a feature a plugin declares.

## Why and evidence

S5b's experimental revision `77972d9a1e5d`, based on `cc6dee07`, was tested live
on 2026-10-26. The [content-free measurement receipt](../../bench/electric-load/evidence/workers-cache-2026-10-26.json)
retains the probe and fleet aggregates. The 20-second hold yielded 12 observed object arrivals for one key
and a 44.47-second maximum empty round. With the ten-second hold, each of five
full canonical keys had exactly one gateway invocation calling its object.
Direct object tail records were absent in the latter capture, so this is a
count of gateway-to-object calls, not independently observed object arrivals.

| Ten-second trial | Responses | Deliberate aborts | Result |
|---|---:|---:|---|
| Empty round 1 | 100 | 0 | One position, cursor advanced |
| Empty round 2 | 100 | 0 | One position, cursor advanced |
| Write | 100 | 0 | All received it; max 2,371 ms |
| Initiating caller abort | 99 | 1 | All survivors received it; max 3,889 ms |
| 30% abort | 70 | 30 | All survivors received it; max 3,194 ms |

All 469 responses were HTTP 200 and private/no-store to the browser; no unexpected
errors. The mixed basic-container trial used 50 signed-out clients on three
networks and 20 signed-in tabs of **one person**, 120 seconds per client (123-second
aggregate window). It returned 8,417 responses, zero 5xx/503/429/unanswered;
write-to-all p99 was 544 ms with 70/70 delivered. Initial up-to-date p99 was
15,299 ms: **the ten-second freshness bar failed**, with 37 signed-out
comments/items pairs slow. This is not evidence for 20 distinct people.

## Limits and checks

Workers Cache is an edge service, not workerd's Cache API. Local workerd checks
prove the real binding/ShapeProxy/cache-header path, scoped rows, stale-handle
recovery and concurrent writes with aborts, not edge collapse. Unit/property
checks cover policy, protocol key preservation and distinct person definitions.
The lander must deploy and rerun the load/collapse proof. Existing-client recovery
across a real container restart and two-person production isolation remain
unproved; the local stale-handle test does not claim a production restart.
No capacity improvement beyond the measured trial is claimed. Initial freshness
and the earlier replication-readiness timeout still need separate investigation.

## Observability and rollback

Keep the existing content-free gateway/object duration, status, outcome and
in-flight records; [observability](../observability.md#electric-gateway-cache)
defines their meaning when a hit bypasses the Worker. Remove experimental
Prometheus sampling, body inspection, per-URL hashes and trial switches.

Rollback by setting gateway `cache.enabled` to false and deploying a new version;
optionally remove the ten-second container override to restore Electric's default.
No data migration or cache purge is required: versions never share entries.
Disabling only live caching in `enabledFor` is also possible, but requires a new
version so old live entries cannot be reused. The safe rollback may restore the
previous overload behavior; rerun the same measured load after either change.
