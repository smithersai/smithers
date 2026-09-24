# Commerce

`commerce.New(pool, client, Config)` exposes the shared billing HTTP contract and
seat reconciliation. The private deployment supplies the payment SDK client,
webhook secret, price IDs, notification sender, and the same `UsageFactory` used
by `admission.NewMetered`.

The worker constructs only admission. It has no payment client, payment API key,
or webhook secret. Both processes read the same durable subscription projection;
workers observe API webhook updates without a process restart.

`Service.Capabilities()` reports actual commerce availability, including whether
the configured catalog has a checkout price. A missing authority is `nil` and
must leave those routes/capabilities absent. It must never select unlimited
admission for a multitenant process.
