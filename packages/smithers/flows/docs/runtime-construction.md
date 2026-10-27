# Runtime construction timings

`flows.runtime.phase` records completed construction phases: `migrations`,
`stores`, `engine`, `registry`, and `registration`. Each includes `phase` and
`durationMs`. Lines follow
`RunMetrics.LineLevel`: Debug by default, Info on Cloudflare. No database connection
string or run payload is recorded. Failed construction emits no successful
phase-duration line.

A phase starts after the dependencies provided outside it have built. The
registration phase includes the registration layer's own dependencies (for
example a sandbox and application services). Registration recovery follows it.
Database opening supplied outside Runtime is not included. These are elapsed
construction intervals, not CPU measurements; do not sum overlapping builds
or compare them to a transaction timestamp as though they shared a clock.

After the registration phase, the runtime recovers every registration's
clocks and deferred completions at once, with one read of each
(`EngineStore.Options.deferRecovery`), and logs `engine-store.registration.recovered`
once, at Info, with how many registrations that recovery covered
(`registrations`) and how long it took (`durationMs`). A flow registered after
that recovers as it registers, logged as `engine-store.registration.flow.recovered`
at Debug. A runtime that registers hundreds of flows therefore reads its store
twice and writes one Info line, not one of each per registration.

The observer uses the caller's layer memo map and resource scope. Observing a phase must not fork the memo map or change the
sharing of services and registrations within the composition.
The runtime's existing isolation between databases remains unchanged.

Construction does not install a temporary parent span: an engine or registration
can capture its construction context for later execution, including durable waits.
Phase observations preserve the host's tracing context instead of retaining a
finished construction span in those services.
