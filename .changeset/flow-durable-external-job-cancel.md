---
"@smthrs/flow": minor
"@smthrs/engine-store": minor
"@smthrs/platform-cloudflare": patch
---

Cancelling an `ExternalJob` parked between probes now stops its work durably, even when no process holds the job.

- `Flow.OnCancel` lets a flow declare its durable cancellation: when a store-backed engine that registers the flow
  cancels one of its executions, it admits the declared flow as a root run, named by the cancelled execution's payload,
  before it commits the cancellation, and records that run in the cancelled state.
- `ExternalJob` declares one for its observation: `<tag>/stop`, run as `cancel:<key>`, whose one step is the
  generation's `cancel`, retried like any step. Before, a run cancelled while its job was parked left the work to the
  provider's own timeout, because the job's rollback lived only in the process that parked it. `flows` now lists
  `<tag>/stop` too; a host that routes by tag must register it. `cancel` may be asked twice for one key.
- A Durable Object host's routing starts a cancelled execution's cancellation run on an object of its own.
