# 0105: Refresh public GitHub mirrors durably

Date: 2026-10-25. Implements Will's mirror-fresh request; no product scope change.

Public Code Storage imports sync only when asked. The clone's existing-row response did not pull, push webhooks
never pulled, and missing commits were indistinguishable from missing paths. This left GitHub permalinks at new
commits returning 404 and branch workspaces resolving old main heads.

Use `@smthrs/effect-code-storage` through the new `repo/Refresh` flow: inspect an admitted clone, pull once, then
wait for Code Storage and GitHub to agree before publishing the head and invalidating refs. App push deliveries
across all repositories request it by delivery identity; read/explicit requests share a per-repository minute.
Compare the current database head at settlement to prevent concurrent runs from overwriting newer observations.

A missing commit answers uncached `503 not_synced`, with a Refresh action, and requests the durable refresh.
A missing path at a present commit remains 404. Choose the explicitly permitted not-synced fallback because the
current Code Storage wrapper exposes no scoped pull operation; do not confuse sandbox read transport with mirror
writes. Retrying and waiting belong to the flow engine, never a request handler or background job.

The core owns this because cloning, admission and Code Storage credentials are existing repository infrastructure.
No public SDK change, migration, provider dependency or new private plugin interface is needed.
