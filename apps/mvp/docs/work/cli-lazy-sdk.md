---
title: Keep provider SDKs off the CLI startup path
status: done
area: sdk
owner: codex-cli-lazy-sdk
updated: 2026-10-29
links: [../../../../../packages/smithers]
---

Load optional provider modules through an injected Effect service only when
their provider is selected. A broken provider install must leave CLI version,
help and unrelated commands usable, and refuse that provider with a typed error
that names its required package. Use the library catalog's `@smthrs/cli` and
`@smthrs/model` entries; no new library or runtime is needed.

Validate package check, lint, importRules, the full coverage suite and a clean
installation's real help command on Latitude. Request a read-only Astra review.
Deliver a local builder bookmark; do not push or deploy.

Audit: Claude Agent SDK was the sole eager provider SDK in the CLI sources.
Codex uses the CLI-owned login and Smithers' HTTP model route, with no Codex
SDK. Smithers' MCP client uses its own protocol services. Incur's MCP server
loads `@modelcontextprotocol/server` and its stdio transport dynamically.
The optional PostgreSQL driver and Bun host also already load dynamically.
The agent, flow, MCP and build sources have no eager vendor SDK imports.

The loader is a typed internal Effect service. Provider construction reports
`ModelError` (`no_route`), adapted to `SeatUnresolved` at seat resolution.
An Effect semaphore keeps concurrent initialization on one cached model and
shutdown handle; failed or cancelled initialization leaves the cache empty.
The existing CLI infrastructure owns this seam; no feature plugin or new
dependency is needed.

Astra found two validation gaps: linked dependencies could still resolve the
SDK, and a test's outer Effect context stopped at the CLI's Promise boundary.
The fixture now copies the runtime dependency graph and removes the SDK from
every package's dependency edges. `Entry.mainEffect` captures host services and
passes them through the shared command and suggestion runtimes. A CLI request
that selects the Claude subscription is the fault-injection positive control.

The second review found embedded interruption did not await cleanup and that
serve/suggest bypassed context forwarding. Commands now share `ControlBridge.run`;
its settlement boundary supplies the context, including serve. Embedded
interruption aborts the command and awaits its cleanup. Regressions cover a
serve judge's provider load and interruption of a pending provider load, without
module mocks. Successful endpoint fixtures use HTTPS, matching endpoint policy.

Fable's error-honesty findings added warning-level safe loader-error categories
and preserved SDK requirements as typed judge configuration errors. The default
loader dispatches by its typed package name. Counters explicitly measure module
resolution results, including Node cache hits; they do not claim disk loads.
Raw loader messages stay out of diagnostics. A throwing diagnostic accessor
cannot replace the provider's typed error. The physical missing-package fixture
checks real CLI commands and the default provider constructor; injected real
commands separately exercise provider selection and typed errors.

Latitude check, lint, importRules and real CLI help pass, following a fresh
frozen install. All 238 focused cases pass (one existing skip). Replacing the
provider adapter with the parent source makes the physical missing-package
regression fail at `--version`; restoring this change makes it pass.

The complete V8 coverage suite passes: 314 files, 5,622 cases, three expected
failures and 38 skips (eight files skipped). Coverage is 96.37% statements,
91.78% branches, 96.37% functions and 97.18% lines, above the existing configured
thresholds. No timeout, sandbox policy, coverage threshold or test selection
was weakened. The host needs bubblewrap on PATH for its confinement tests.

Earlier missing-bubblewrap failures pass after supplying that dependency. A
PostgreSQL history-verification timeout reproduced on the parent source;
diagnostics then showed adoption advancing correctly, and the unchanged test
passes both its focused rerun and the final full coverage suite. The final
read-only Astra and Fable reviews report no remaining findings.
