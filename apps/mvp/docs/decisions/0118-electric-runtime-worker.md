# 0118: Electric owns a separate Worker script

Date: 2026-10-26

## Decision

ElectricRuntime owns ElectricObject and the Electric container. ElectricGateway holds only a cross-script namespace binding, admission, cache policy and forwarding. Runtime configuration does not import gateway cache policy or ChatApi. The database secret binds only to the runtime.

Two designs and the source investigation are recorded in [the work note](../work/electric-s7.md). Deterministic bundling of the combined script cannot meet the gateway-change requirement. Persistent storage would reduce rebuild costs but would not prevent restarts.

## Alchemy evidence and limits

Installed Alchemy 2.0.0-beta.83 `WorkerProvider.js` compares canonical metadata (`hasChanged`, lines 3368-3410), emitted bundle hash (3471), and normalized props (3700-3730). Its `Sources/Rolldown.js` virtual entry uses class names and stack/stage, not a build timestamp; `Bundle/Bundle.js` hashes emitted files. Gateway edits change the owner bundle today and therefore trigger upload of the script hosting ElectricObject. There is no unconditional upload in this diff path. The historical claim that every ChatApi-only deploy uploads Electric cannot be attributed to a specific differing field without deployed state receipts; no invented build-stamp cause is asserted.

The modular DurableObject API supports `transferredFrom: "ElectricGateway"`, `.make(implementation)` and `.from(ElectricRuntime)`. The latter binds the runtime's stable script name and orders the owner before the gateway. WorkerProvider's namespace reconciliation (2630-2850) distinguishes foreign bindings and transfers from creates/deletes. Stable bundles, metadata and props permit noop; the regression checks actual Alchemy bundle output under ChatApi and gateway changes.

## Migration

Keep class and instance names ElectricObject and electric. Transfer the existing namespace; never create a new destination namespace first, delete the source namespace, or run both Electric instances against the same replication configuration. Alchemy's destination declaration carries the former host's logical id and discovers its physical name through ownership tags.

Cloudflare's [class transfer rules](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/#transfer-a-durable-object-class-between-workers) require destination preparation before source relinquishment; Alchemy emits the expecting-transfer/transferred export handshake. [Legacy migrations](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/#transfer-migration) likewise forbid a create at the destination before transfer. Use Alchemy only, not a Wrangler file or manual API mutation. Deployment order and verification are in [infrastructure](../infrastructure.md#electric-deployment-isolation).

The one-time ownership/code move may restart Electric and rebuild shapes. This decision promises subsequent unrelated app deploy isolation, not persistent container disk, survival beyond six idle hours, or uninterrupted provider maintenance.

Electric's existing default/fleet container remains the root `Electric` resource. Installed
`ContainerConfiguration.js:90,137-139` makes the host-keyed application path exclusive to
`schedulingPolicy: "durable_object"`, which Electric does not set. `ContainerPlatform.js:29-58` attaches the existing
fleet application directly to the namespace. Preserve its root id and transferred namespace id; there is no
container state-row rename and no second application to create. The declaration-graph regression enforces this.
